/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import System from 'system';

import { finish } from './finish.js';
import { RECOVERY_FORMAT } from '../extension/core/recovery.js';
import { readRecovery, writeRecovery } from '../extension/core/storage.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

const captured = {
    environment: {
        gnomeShell: '50.1',
        sessionType: 'wayland',
        dynamicWorkspaces: true,
        workspacesOnlyOnPrimary: true,
        workspaceCountSetting: 4,
    },
    workspaceCount: 2,
    activeWorkspaceIndex: 1,
    focusedWindowKey: '11111111-1111-4111-8111-111111111111',
    workspaceLabels: ['', ''],
    monitors: [{
        index: 0,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        scale: 1,
        connector: 'eDP-1',
        vendor: null,
        product: null,
        serial: 'ABC',
        primary: true,
        builtin: true,
    }],
    windows: [{
        key: '11111111-1111-4111-8111-111111111111',
        app: {
            desktopId: 'org.gnome.TextEditor.desktop',
            name: 'Text Editor',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: null,
            wmClassInstance: null,
        },
        title: 'notes.txt',
        windowType: 'normal',
        clientType: 'wayland',
        workspaceIndex: 1,
        onAllWorkspaces: false,
        monitorIndex: 0,
        monitorConnector: 'eDP-1',
        monitorSerial: 'ABC',
        frame: { x: 0, y: 0, width: 800, height: 600 },
        state: {
            maximizedHorizontally: false,
            maximizedVertically: false,
            fullscreen: false,
            minimized: false,
            above: false,
        },
        role: null,
        tag: null,
        context: { provider: 'document', data: { path: '/home/user/notes.txt' } },
    }],
    captureWarnings: [],
};

const path = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `workspace-sessions-recovery-${GLib.random_int()}`,
    'recovery.json',
]);
assert(finish(readRecovery(path)) === null, 'a missing recovery file is ignored');
writeRecovery({
    clean: false,
    savedAt: '2026-10-15T00:30:00Z',
    captured,
}, path);
const dirty = finish(readRecovery(path));
assert(dirty && dirty.clean === false, 'a crash snapshot stays dirty');
assert(dirty?.captured.windows[0].context.data.path === '/home/user/notes.txt', 'a crash snapshot keeps the document');
assert(dirty?.captured.windows.length === 1, 'a crash snapshot keeps its windows');
writeRecovery({ ...dirty, clean: true }, path);
assert(finish(readRecovery(path))?.clean === true, 'a clean shutdown clears the crash flag');

try {
    writeRecovery({
        clean: false,
        savedAt: '2026-10-15T00:30:00Z',
        captured: {
            ...captured,
            windows: [{
                ...captured.windows[0],
                context: { provider: 'document', data: { path: '/home/user/notes.txt', command: 'echo owned' } },
            }],
        },
    }, path);
    failures.push('a recovery snapshot accepted a command');
} catch {
    // expected
}
assert(finish(readRecovery(path))?.clean === true, 'a rejected snapshot leaves the previous file alone');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}
print('recovery tests passed');
