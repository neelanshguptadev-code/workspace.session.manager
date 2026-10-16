/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import System from 'system';

import { planMerge } from '../extension/core/matching.js';
import { assignFirefoxWindows } from '../extension/integrations/firefox.js';
import { decodeMozLz4 } from '../extension/integrations/mozlz4.js';
import { directoryForTitle, planDirectoryLaunch, resolvePlaces } from '../extension/integrations/places.js';
import {
    assignTerminalWindows,
    planTerminalLaunch,
    sessionCoversDirectories,
    shouldDeferToPtyxisRestore,
    terminalDirectory,
} from '../extension/integrations/terminal.js';
import { codeKind } from '../extension/integrations/vscode.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

const places = [
    { name: 'Home', path: '/home/user' },
    { name: 'Documents', path: '/home/user/Documents' },
    { name: 'Downloads', path: '/home/user/Downloads' },
];
assert(directoryForTitle('Home', places) === '/home/user', 'Home opens the home directory');
assert(directoryForTitle('Documents', places) === '/home/user/Documents', 'a file window title selects that folder');
assert(directoryForTitle('Missing', places) === null, 'an unknown folder is not guessed');

const identity = path => path.replace('/home/user/Desktop/Data', '/mnt/data');
const resolved = resolvePlaces([
    [{ name: 'Home', path: '/home/user' }],
    [{ name: 'acads', path: '/home/user/Desktop/Data/Y2/acads' }],
    [{ name: 'acads', path: '/home/user/other/acads' }],
    [
        { name: 'notes', path: '/home/user/a/notes' },
        { name: 'notes', path: '/home/user/b/notes' },
        { name: 'acads', path: '/mnt/data/Y2/acads' },
    ],
], identity);
assert(directoryForTitle('acads', resolved) === '/home/user/Desktop/Data/Y2/acads', 'a bookmarked folder wins over later places');
assert(directoryForTitle('notes', resolved) === null, 'two different folders with one name are not guessed');

const files = planDirectoryLaunch('/usr/bin/nautilus', ['--new-window'], { path: '/home/user/Documents' });
assert(files?.argv?.join('\n') === '/usr/bin/nautilus\n--new-window\n/home/user/Documents', 'a folder is one launch argument');
assert(planDirectoryLaunch('/usr/bin/nautilus', [], { path: '/tmp/../etc' }) === null, 'a parent path is not opened');

assert(terminalDirectory('file://NeelanshLinux/home/user') === '/home/user', 'a terminal cwd keeps the path after the host');
assert(terminalDirectory('file:///home/user/src') === '/home/user/src', 'a file URI cwd is accepted');
const terminal = assignTerminalWindows([
    { id: 'one', title: 'user@host: ~' },
], [{
    directories: ['/home/user', '/home/user/src'],
    title: 'user@host: ~',
}]);
assert(terminal.get('one')?.data.directories[0] === '/home/user', 'the open terminal keeps its directory');
const terminalArgv = planTerminalLaunch('/usr/bin/ptyxis', { directories: ['/home/user', '/home/user/src'] });
assert(terminalArgv?.argv?.join('\n') === '/usr/bin/ptyxis\n--new-window\n--working-directory=/home/user\n--tab\n--working-directory=/home/user/src', 'extra terminals become tabs');
assert(!terminalArgv?.argv?.some(arg => arg.includes('execute')), 'a terminal is not given a command');
const ptyxisSessions = [{ directories: ['/home/user', '/home/user/src'] }];
assert(sessionCoversDirectories(ptyxisSessions, ['/home/user']), 'a saved terminal is already in the Ptyxis session');
assert(shouldDeferToPtyxisRestore(['/home/user'], {
    alreadyRunning: false,
    restoreEnabled: true,
    sessions: ptyxisSessions,
}), 'Ptyxis can restore a closed terminal itself');
assert(!shouldDeferToPtyxisRestore(['/home/user'], {
    alreadyRunning: true,
    restoreEnabled: true,
    sessions: ptyxisSessions,
}), 'a running terminal still needs a new window');
const restored = planTerminalLaunch('/usr/bin/ptyxis', { directories: ['/home/user'] }, { restoreSession: true });
assert(restored?.argv?.join('\n') === '/usr/bin/ptyxis' && restored.claimRestore === true, 'session restore is not given the directory again');
assert(planTerminalLaunch('/usr/bin/ptyxis', { directories: ['/home/user'] }, {
    restoreSession: true,
    alreadyClaimed: true,
})?.skip === true, 'one Ptyxis restore covers every saved terminal window');

assert(codeKind('cursor.desktop', 'Cursor') === 'cursor', 'Cursor uses the editor adapter');
assert(codeKind('code_code.desktop', 'Code') === 'code', 'VS Code still uses the editor adapter');

const compressed = Uint8Array.from([
    0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00,
    2, 0, 0, 0,
    0x20, 0x5b, 0x5d,
]);
assert(new TextDecoder().decode(decodeMozLz4(compressed)) === '[]', 'a Firefox session block decodes');
const firefox = assignFirefoxWindows([
    { id: 'mail', title: 'Inbox — Mozilla Firefox' },
], [{
    profileName: 'default',
    title: 'Inbox',
    urls: ['https://mail.example/'],
}]);
assert(firefox.get('mail')?.data.profileName === 'default', 'Firefox keeps its profile');
assert(firefox.get('mail')?.data.urls[0] === 'https://mail.example/', 'Firefox keeps the open tab');

function windowRecord(key, desktopId, name, title, context) {
    return {
        key,
        liveId: key,
        app: {
            desktopId,
            name,
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: desktopId,
            wmClassInstance: desktopId,
        },
        title,
        windowType: 'normal',
        clientType: 'wayland',
        workspaceIndex: 0,
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
        context,
    };
}

const plan = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [
        windowRecord('files', 'org.gnome.Nautilus.desktop', 'Files', 'Documents', {
            provider: 'directory',
            data: { path: '/home/user/Documents' },
        }),
    ],
}, [], [{
    index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    connector: 'eDP-1', serial: 'ABC', primary: true, builtin: true,
}]);
assert(plan.actions[0]?.type === 'launch', 'a closed file window is opened');
assert(plan.actions[0]?.context?.data.path === '/home/user/Documents', 'the launch keeps the folder');

const monitors = [{
    index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    connector: 'eDP-1', serial: 'ABC', primary: true, builtin: true,
}];
const savedFolder = windowRecord('saved-docs', 'org.gnome.Nautilus.desktop', 'Files', 'Documents', {
    provider: 'directory',
    data: { path: '/home/user/Documents' },
});
const otherFolder = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [savedFolder],
}, [
    windowRecord('live-downloads', 'org.gnome.Nautilus.desktop', 'Files', 'Downloads', {
        provider: 'directory',
        data: { path: '/home/user/Downloads' },
    }),
], monitors);
assert(otherFolder.actions[0]?.type === 'launch', 'a different open folder does not count as the saved folder');
assert(otherFolder.actions[0]?.context?.data.path === '/home/user/Documents', 'restore opens the saved folder');
assert(otherFolder.summary.unrelated === 1, 'the other Files window stays open');

const otherPage = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [savedFolder],
}, [
    windowRecord('live-recent', 'org.gnome.Nautilus.desktop', 'Files', 'Recent', null),
], monitors);
assert(otherPage.actions[0]?.type === 'launch', 'Recent does not stand in for a saved folder');

const sameFolder = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [savedFolder],
}, [
    windowRecord('live-docs', 'org.gnome.Nautilus.desktop', 'Files', 'Documents', {
        provider: 'directory',
        data: { path: '/home/user/Documents' },
    }),
], monitors);
assert(sameFolder.actions[0]?.type === 'keep', 'the saved folder is left as it is when already open');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}
print('context tests passed');
