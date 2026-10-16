/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

import { sessionSignature } from '../core/model.js';
import { writeRecovery } from '../core/storage.js';

const QUIET_MS = 60000;

function timestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Write one recovery snapshot after the desktop has been still for a minute,
 * and a clean snapshot when the shell shuts down. This does not save on a timer
 * while the desktop is changing, and it does not restore anything by itself.
 */
export function startRecoveryWatch(capture) {
    let held = false;
    let destroyed = false;
    let quietId = 0;
    let lastSignature = null;
    let lastCaptured = null;
    const disconnectors = [];

    const connect = (object, signal, handler) => {
        if (!object?.connect)
            return;
        let id = 0;
        try {
            id = object.connect(signal, handler);
        } catch {
            return;
        }
        disconnectors.push(() => {
            try {
                object.disconnect(id);
            } catch {
                // The object may already have been destroyed.
            }
        });
    };

    const snapshot = async clean => {
        if (destroyed || (held && !clean))
            return;
        let captured;
        try {
            captured = await capture();
        } catch {
            return;
        }
        if (destroyed)
            return;
        const signature = `${captured.activeWorkspaceIndex ?? ''}\n${sessionSignature(captured)}`;
        if (!clean && signature === lastSignature)
            return;
        try {
            writeRecovery({
                clean,
                savedAt: timestamp(),
                captured,
            });
            lastSignature = signature;
            lastCaptured = captured;
        } catch {
            // Keep the previous snapshot when this one cannot be stored.
        }
    };

    const schedule = () => {
        if (held)
            return;
        if (quietId) {
            GLib.Source.remove(quietId);
            quietId = 0;
        }
        quietId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, QUIET_MS, () => {
            quietId = 0;
            snapshot(false).catch(() => {
                // The next quiet period can try again.
            });
            return GLib.SOURCE_REMOVE;
        });
    };

    const watchWindow = metaWindow => {
        connect(metaWindow, 'unmanaged', () => schedule());
    };

    let display = null;
    try {
        display = global.display;
    } catch {
        display = null;
    }
    connect(display, 'window-created', (_display, metaWindow) => {
        watchWindow(metaWindow);
        schedule();
    });
    try {
        for (const metaWindow of display?.list_all_windows?.() ?? [])
            watchWindow(metaWindow);
    } catch {
        // A display without a window list still gets later window-created signals.
    }

    let manager = null;
    try {
        manager = display?.get_workspace_manager?.() ?? null;
    } catch {
        manager = null;
    }
    connect(manager, 'workspace-added', () => schedule());
    connect(manager, 'workspace-removed', () => schedule());
    connect(manager, 'active-workspace-changed', () => schedule());
    schedule();

    return {
        hold() {
            held = true;
            if (quietId) {
                GLib.Source.remove(quietId);
                quietId = 0;
            }
        },
        release() {
            held = false;
            schedule();
        },
        flushClean() {
            if (held || !lastCaptured)
                return;
            try {
                writeRecovery({
                    clean: true,
                    savedAt: timestamp(),
                    captured: lastCaptured,
                });
            } catch {
                // Never delay locking or shutdown for recovery bookkeeping.
            }
        },
        destroy() {
            destroyed = true;
            if (quietId) {
                GLib.Source.remove(quietId);
                quietId = 0;
            }
            held = true;
            for (const disconnect of disconnectors.splice(0))
                disconnect();
        },
    };
}
