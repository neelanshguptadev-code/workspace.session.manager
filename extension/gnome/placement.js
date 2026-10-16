/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const MONITOR_WAIT_MS = 1500;

function currentTime() {
    return global.get_current_time?.() || global.display.get_current_time() || 1;
}

function maximizeFlags(state) {
    let flags = 0;
    if (state?.maximizedHorizontally)
        flags |= Meta.MaximizeFlags.HORIZONTAL;
    if (state?.maximizedVertically)
        flags |= Meta.MaximizeFlags.VERTICAL;
    return flags;
}

function clampFrame(display, window, frame, monitorIndex) {
    if (!frame)
        return null;
    let area;
    try {
        area = window.get_work_area_for_monitor(monitorIndex);
    } catch {
        area = null;
    }
    if (!area) {
        try {
            area = display.get_monitor_geometry(monitorIndex);
        } catch {
            return frame;
        }
    }
    const width = Math.min(Math.max(frame.width, 1), area.width);
    const height = Math.min(Math.max(frame.height, 1), area.height);
    const x = Math.min(Math.max(frame.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(frame.y, area.y), area.y + area.height - height);
    return { x, y, width, height };
}

function wants(action, change) {
    return action.changes?.includes(change);
}

function changeWorkspace(display, window, workspaceIndex) {
    if (!Number.isInteger(workspaceIndex) || workspaceIndex < 0)
        return;
    const count = display.get_workspace_manager().get_n_workspaces();
    window.change_workspace_by_index(workspaceIndex, workspaceIndex >= count);
}

export function moveWindowToMonitor(display, window, monitorIndex, job) {
    return new Promise(resolve => {
        let finished = false;
        let timeoutId = 0;
        let signalId = 0;
        const finish = moved => {
            if (finished)
                return;
            finished = true;
            if (signalId) {
                display.disconnect(signalId);
                signalId = 0;
            }
            if (timeoutId) {
                GLib.Source.remove(timeoutId);
                timeoutId = 0;
            }
            resolve(moved && !job?.isCancelled());
        };
        job?.addCleanup(() => finish(false));

        let currentMonitor = -1;
        try {
            currentMonitor = window.get_monitor();
        } catch {
            finish(false);
            return;
        }
        if (!Number.isInteger(monitorIndex) || monitorIndex === currentMonitor) {
            finish(true);
            return;
        }
        if (job?.isCancelled()) {
            finish(false);
            return;
        }

        signalId = display.connect('window-entered-monitor', (_display, index, entered) => {
            if (entered !== window || index !== monitorIndex)
                return;
            finish(true);
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_WAIT_MS, () => {
            timeoutId = 0;
            let arrived = false;
            try {
                arrived = window.get_monitor() === monitorIndex;
            } catch {
                arrived = false;
            }
            finish(arrived);
            return GLib.SOURCE_REMOVE;
        });
        try {
            window.move_to_monitor(monitorIndex);
        } catch {
            finish(false);
        }
    });
}

export async function applyWindowPlacement(display, window, action, job) {
    if (job.isCancelled())
        return 'cancelled';
    if (!window)
        return 'missing';

    if (wants(action, 'stick')) {
        try {
            if (action.onAllWorkspaces)
                window.stick();
            else if (window.is_on_all_workspaces())
                window.unstick();
        } catch {
            // stick is best-effort
        }
    }

    if (wants(action, 'monitor')) {
        const moved = await moveWindowToMonitor(display, window, action.monitorIndex, job);
        if (job.isCancelled())
            return 'cancelled';
        if (!moved)
            return 'failed';
    }
    if (job.isCancelled())
        return 'cancelled';

    if (wants(action, 'workspace')) {
        try {
            changeWorkspace(display, window, action.workspaceIndex);
        } catch {
            return 'failed';
        }
    }

    const state = action.state ?? {};
    if (wants(action, 'state')) {
        try {
            if (window.minimized && !state.minimized)
                window.unminimize();
            if (window.is_fullscreen() && !state.fullscreen)
                window.unmake_fullscreen();
            const desiredFlags = maximizeFlags(state);
            if (!state.fullscreen && window.get_maximize_flags() !== desiredFlags)
                window.unmaximize();
        } catch {
            // State resets are best-effort.
        }
    }

    if (wants(action, 'geometry') && action.frame &&
        !state.fullscreen && !state.maximizedHorizontally && !state.maximizedVertically) {
        const frame = clampFrame(display, window, action.frame, action.monitorIndex ?? window.get_monitor());
        if (frame && frame.width > 0 && frame.height > 0) {
            try {
                window.move_resize_frame(false, frame.x, frame.y, frame.width, frame.height);
            } catch {
                // Clients may ignore the configure.
            }
        }
    }

    if (wants(action, 'state')) {
        try {
            const flags = maximizeFlags(state);
            if (flags)
                window.set_maximize_flags(flags);
            if (state.fullscreen)
                window.make_fullscreen();
            if (state.above)
                window.make_above();
            else if (window.is_above())
                window.unmake_above();
            if (state.minimized)
                window.minimize();
        } catch {
            // Window state is best-effort on Wayland.
        }
    }
    return 'applied';
}

export function activateWorkspaceAndWindow(display, window, workspaceIndex) {
    if (!Number.isInteger(workspaceIndex) || workspaceIndex < 0)
        return;
    const workspaceManager = display.get_workspace_manager();
    const workspace = workspaceManager.get_workspace_by_index(workspaceIndex);
    if (!workspace)
        return;
    try {
        workspace.activate(currentTime());
    } catch {
        // Activating the workspace is optional.
    }
    if (!window)
        return;
    try {
        if (window.get_workspace()?.index() !== workspaceIndex)
            return;
        window.activate(currentTime());
    } catch {
        // Focus restore is optional.
    }
}
