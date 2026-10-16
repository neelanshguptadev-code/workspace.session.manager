/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import System from 'system';

import { finish } from './finish.js';

import {
    createSession,
    duplicateSession,
    findSameSession,
    renameSession,
    restorePreviousCapture,
    sessionForSelection,
    validateSession,
    withUpdatedCapture,
} from '../extension/core/model.js';
import {
    deleteSession,
    listSessions,
    readSession,
    writeSession,
} from '../extension/core/storage.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

function sampleCaptured() {
    return {
        environment: {
            gnomeShell: '50.1',
            sessionType: 'wayland',
            dynamicWorkspaces: true,
            workspacesOnlyOnPrimary: true,
            workspaceCountSetting: 4,
        },
        workspaceCount: 3,
        activeWorkspaceIndex: 1,
        focusedWindowKey: '11111111-1111-4111-8111-111111111111',
        workspaceLabels: ['', ''],
        monitors: [{
            index: 0,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.5,
            connector: 'eDP-1',
            vendor: 'Vendor',
            product: 'Panel',
            serial: 'ABC',
            primary: true,
            builtin: true,
        }],
        windows: [{
            key: '11111111-1111-4111-8111-111111111111',
            app: {
                desktopId: 'code.desktop',
                name: 'Visual Studio Code',
                gtkApplicationId: null,
                sandboxedAppId: null,
                wmClass: 'code',
                wmClassInstance: 'code',
            },
            title: 'project — Visual Studio Code',
            windowType: 'normal',
            clientType: 'wayland',
            workspaceIndex: 1,
            onAllWorkspaces: false,
            monitorIndex: 0,
            monitorConnector: 'eDP-1',
            monitorSerial: 'ABC',
            frame: { x: 10, y: 32, width: 1200, height: 800 },
            state: {
                maximizedHorizontally: false,
                maximizedVertically: false,
                fullscreen: false,
                minimized: false,
                above: false,
            },
            role: null,
            tag: null,
            context: null,
        }],
        captureWarnings: [],
    };
}

const now = '2026-10-10T18:00:00Z';
const id = '22222222-2222-4222-8222-222222222222';
const session = createSession({
    id,
    name: '  Development  ',
    captured: sampleCaptured(),
    now,
});

const valid = validateSession(session);
assert(valid.ok, `expected a valid session: ${valid.ok ? '' : valid.errors.join('; ')}`);
assert(valid.ok && valid.session.name === 'Development', 'name should be trimmed');
assert(valid.ok && !Object.hasOwn(valid.session, 'command'), 'normalized session has no command field');

const hostile = validateSession({
    ...session,
    command: 'echo owned',
});
assert(!hostile.ok, 'a command field must be rejected');

const badGeometry = validateSession({
    ...session,
    windows: [{
        ...session.windows[0],
        frame: { x: 0, y: 0, width: 0, height: 10 },
    }],
});
assert(!badGeometry.ok, 'zero width must be rejected');

const badDesktop = validateSession({
    ...session,
    windows: [{
        ...session.windows[0],
        app: { ...session.windows[0].app, desktopId: '../code.desktop' },
    }],
});
assert(!badDesktop.ok, 'a path-like desktop id must be rejected');

const renamed = validateSession(renameSession(session, 'College'));
assert(renamed.ok && renamed.session.name === 'College', 'rename should validate');
assert(renamed.ok && renamed.session.createdAt === now, 'rename keeps the original creation time');
assert(renamed.ok && renamed.session.updatedAt === session.updatedAt, 'rename keeps the last desktop update time');

const sameDesktop = sampleCaptured();
sameDesktop.windows[0].title = 'other file — project — Visual Studio Code';
sameDesktop.windows[0].frame = { x: 40, y: 60, width: 900, height: 700 };
assert(findSameSession(sameDesktop, [session])?.id === session.id, 'the same apps on the same workspaces count as an existing session');
const movedDesktop = sampleCaptured();
movedDesktop.windows[0].workspaceIndex = 2;
assert(findSameSession(movedDesktop, [session]) === null, 'a window on another workspace is a different session');
const otherFolder = sampleCaptured();
otherFolder.windows[0].context = { provider: 'vscode', data: { folder: '/projects/college' } };
assert(findSameSession(otherFolder, [session]) === null, 'a different folder is a different session');
const reordered = { windows: [...sampleCaptured().windows].reverse() };
assert(findSameSession(reordered, [session])?.id === session.id, 'window order does not matter');
assert(findSameSession({ windows: [] }, [session]) === null, 'an empty desktop is not matched');

const copy = duplicateSession(session, '33333333-3333-4333-8333-333333333333', '2026-10-10T19:00:00Z');
const copied = validateSession(copy);
assert(copied.ok && copied.session.id !== session.id, 'duplicate gets a new id');
assert(copied.ok && copied.session.name === 'Development copy', 'duplicate name');

const directory = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `workspace-sessions-test-${GLib.random_int()}`,
]);
const written = writeSession(session, directory);
assert(written.endsWith(`${id}.json`), `unexpected path ${written}`);
const loaded = finish(readSession(id, directory));
assert(loaded.name === 'Development', 'round trip name');
assert(loaded.windows[0].app.desktopId === 'code.desktop', 'round trip desktop id');
assert(!Object.hasOwn(loaded, 'pid'), 'pid is not stored');

const updated = withUpdatedCapture(loaded, {
    ...sampleCaptured(),
    workspaceCount: 4,
    captureWarnings: ['Skipped 2 windows that are not normal application windows'],
}, '2026-10-10T20:00:00Z');
writeSession(updated, directory);
const listed = finish(listSessions(directory));
assert(listed.errors.length === 0, `list errors: ${listed.errors.join('; ')}`);
assert(listed.sessions.length === 1 && listed.sessions[0].workspaceCount === 4, 'updated count');

writeSession(copy, directory);
deleteSession(id, directory);
const afterDelete = finish(listSessions(directory));
assert(afterDelete.sessions.length === 1 && afterDelete.sessions[0].id === copy.id, 'delete removes one file');

try {
    writeSession({ ...session, formatVersion: 99 }, directory);
    failures.push('an unknown format version was written');
} catch {
    // expected
}

const undoDirectory = GLib.build_filenamev([
    GLib.get_tmp_dir(),
    `workspace-sessions-undo-${GLib.random_int()}`,
]);
writeSession(session, undoDirectory);
const replaced = withUpdatedCapture(session, {
    ...sampleCaptured(),
    workspaceCount: 2,
    activeWorkspaceIndex: 0,
}, '2026-10-10T21:00:00Z');
replaced.name = 'Renamed';
const reverted = restorePreviousCapture(replaced, finish(readSession(id, undoDirectory)));
assert(validateSession(reverted).ok, 'an undone session stays valid');
assert(reverted.name === 'Renamed', 'undo keeps the name chosen after the update');
assert(reverted.createdAt === session.createdAt, 'undo keeps the original creation time');
assert(reverted.workspaceCount === 3, 'undo puts back the previous desktop');
assert(reverted.updatedAt === session.updatedAt, 'undo puts back the previous update time');
assert(finish(listSessions(directory)).sessions.length === 1, 'an undo copy is not another saved session');

const secondWindow = {
    ...session.windows[0],
    key: '44444444-4444-4444-8444-444444444444',
    workspaceIndex: 2,
    onAllWorkspaces: false,
};
const stickyWindow = {
    ...session.windows[0],
    key: '55555555-5555-4555-8555-555555555555',
    onAllWorkspaces: true,
    workspaceIndex: null,
};
const multi = {
    ...session,
    windows: [session.windows[0], secondWindow, stickyWindow],
    focusedWindowKey: secondWindow.key,
    activeWorkspaceIndex: 2,
};
const oneWorkspace = sessionForSelection(multi, { workspaceIndexes: [2] });
assert(oneWorkspace.windows.length === 1 && oneWorkspace.windows[0].key === secondWindow.key, 'one workspace restores only its windows');
assert(oneWorkspace.focusedWindowKey === secondWindow.key, 'focus stays when that window is selected');
const otherWorkspace = sessionForSelection(multi, { workspaceIndexes: [1] });
assert(otherWorkspace.windows.length === 1 && otherWorkspace.windows[0].key === session.windows[0].key, 'another workspace leaves the rest out');
assert(otherWorkspace.focusedWindowKey === null, 'focus is cleared when that window is not restored');
assert(otherWorkspace.activeWorkspaceIndex === 1, 'restore activates the workspace that was chosen');
const oneWindow = sessionForSelection(multi, { windowKeys: [stickyWindow.key] });
assert(oneWindow.windows.length === 1 && oneWindow.windows[0].onAllWorkspaces, 'a chosen sticky window can be restored on its own');
const none = sessionForSelection(multi, { windowKeys: [] });
assert(none.windows.length === 0, 'an empty selection restores nothing');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}

print(`ok ${listed.sessions.length + afterDelete.sessions.length} session records exercised`);
