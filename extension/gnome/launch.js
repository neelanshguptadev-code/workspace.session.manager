/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { planAppLaunch } from '../integrations/app-launch.js';
import { applyWindowPlacement } from './placement.js';

const LAUNCH_TIMEOUT_MS = 12000;
const BROWSER_LAUNCH_TIMEOUT_MS = 20000;

function normalWindows(app) {
    return app.get_windows().filter(window => window.get_window_type() === Meta.WindowType.NORMAL);
}

function isLaunchWindow(app, metaWindow, seenIds) {
    if (!metaWindow || seenIds.has(metaWindow.get_id()))
        return false;
    try {
        if (metaWindow.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
    } catch {
        return false;
    }
    const found = Shell.WindowTracker.get_default().get_window_app(metaWindow);
    return found === app || found?.get_id() === app.get_id();
}

function requestLaunch(app, workspaceIndex) {
    const workspace = Number.isInteger(workspaceIndex) ? workspaceIndex : -1;
    if (app.get_n_windows() > 0 && app.can_open_new_window())
        return app.open_new_window(workspace) !== false;
    return app.launch(0, workspace, Shell.AppLaunchGpu.APP_PREF) !== false;
}

/**
 * Launch one missing application and place the new window.
 * Does not close, kill, or pass a shell command.
 */
export async function launchAndPlace(display, action, job) {
    const app = Shell.AppSystem.get_default().lookup_app(action.desktopId);
    if (!app)
        return { status: 'failed', window: null };
    const planned = await planAppLaunch(action, job, {
        alreadyRunning: normalWindows(app).length > 0,
    });
    if (planned?.skip)
        return { status: 'skipped', window: null };
    if (planned?.failed)
        return { status: 'failed', window: null };

    const matchesTitle = planned?.matchesTitle ?? null;
    if (matchesTitle) {
        if (normalWindows(app).some(window => matchesTitle(window.get_title())))
            return Promise.resolve({ status: 'skipped', window: null });
    } else if (normalWindows(app).length >= action.savedAppCount) {
        return Promise.resolve({ status: 'skipped', window: null });
    }

    return new Promise(resolve => {
        const seenIds = new Set(app.get_windows().map(window => window.get_id()));
        let settled = false;
        let timeoutId = 0;
        let createdId = 0;
        let changedId = 0;
        const shownIds = [];

        const disconnect = () => {
            if (createdId) {
                display.disconnect(createdId);
                createdId = 0;
            }
            if (changedId) {
                app.disconnect(changedId);
                changedId = 0;
            }
            if (timeoutId) {
                GLib.Source.remove(timeoutId);
                timeoutId = 0;
            }
            for (const entry of shownIds.splice(0)) {
                try {
                    entry.window.disconnect(entry.id);
                } catch {
                    // The window may already be gone.
                }
            }
        };

        const finish = (status, metaWindow) => {
            if (settled)
                return;
            settled = true;
            disconnect();
            if (status !== 'appeared' || !metaWindow || job.isCancelled()) {
                resolve({ status: job.isCancelled() ? 'cancelled' : status, window: metaWindow ?? null });
                return;
            }
            applyWindowPlacement(display, metaWindow, action, job).then(placed => {
                if (placed === 'cancelled' || job.isCancelled())
                    resolve({ status: 'cancelled', window: metaWindow });
                else if (placed === 'failed')
                    resolve({ status: 'failed', window: metaWindow });
                else
                    resolve({ status: 'launched', window: metaWindow });
            }).catch(() => {
                resolve({ status: 'failed', window: metaWindow });
            });
        };

        const watched = new Set();
        const consider = metaWindow => {
            if (settled || job.isCancelled() || !isLaunchWindow(app, metaWindow, seenIds))
                return;
            const id = metaWindow.get_id();
            if (!watched.has(id)) {
                watched.add(id);
                shownIds.push({ window: metaWindow, id: metaWindow.connect('shown', () => consider(metaWindow)) });
                if (matchesTitle)
                    shownIds.push({ window: metaWindow, id: metaWindow.connect('notify::title', () => consider(metaWindow)) });
            }
            if (!metaWindow.mapped)
                return;
            if (matchesTitle && !matchesTitle(metaWindow.get_title()))
                return;
            seenIds.add(id);
            finish('appeared', metaWindow);
        };

        job.addCleanup(() => finish('cancelled', null));
        createdId = display.connect('window-created', (_display, metaWindow) => consider(metaWindow));
        changedId = app.connect('windows-changed', () => {
            for (const metaWindow of app.get_windows())
                consider(metaWindow);
        });
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, planned?.slow ? BROWSER_LAUNCH_TIMEOUT_MS : LAUNCH_TIMEOUT_MS, () => {
            timeoutId = 0;
            finish('failed', null);
            return GLib.SOURCE_REMOVE;
        });

        try {
            const directArgv = planned?.argv;
            if (directArgv) {
                Gio.Subprocess.new(
                    directArgv,
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
            } else if (!requestLaunch(app, action.workspaceIndex)) {
                finish('failed', null);
            }
        } catch {
            if (planned?.claimRestore && job)
                job.ptyxisRestored = false;
            finish('failed', null);
        }
    });
}
