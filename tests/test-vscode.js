/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import System from 'system';

import { planMerge } from '../extension/core/matching.js';
import {
    assignCodeWindows,
    codeKind,
    codeTitleMatches,
    fileUriToPath,
    parseCodeRoot,
    planCodeLaunch,
    safePath,
} from '../extension/integrations/vscode.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

assert(codeKind('code_code.desktop', 'Code') === 'code', 'snap code desktop id');
assert(codeKind('code.desktop', 'Code') === 'code', 'deb code desktop id');
assert(codeKind('brave_brave.desktop', 'brave-browser') === null, 'brave is not an editor');
assert(parseCodeRoot('readme.md — internship — Visual Studio Code') === 'internship', 'folder is the segment before the app name');
assert(parseCodeRoot('ubuntu workspace extension — Visual Studio Code') === 'ubuntu workspace extension', 'a folder name with spaces is kept whole');
assert(parseCodeRoot('● app.js - college - Visual Studio Code') === 'college', 'a dirty file marker is ignored');
assert(parseCodeRoot('project [SSH: lab] — Visual Studio Code') === '', 'a remote window is not given a local folder');
assert(fileUriToPath('file:///home/user/ubuntu%20workspace%20extension') === '/home/user/ubuntu workspace extension', 'file URIs are decoded');
assert(safePath('/tmp/../etc/passwd') === null, 'parent segments are rejected');
assert(safePath('/tmp/project\nname') === null, 'paths with newlines are rejected');

const projects = [
    { folder: '/projects/internship', workspaceFile: null, basename: 'internship', frame: { x: 10, y: 32, width: 1200, height: 800 } },
    { folder: '/projects/college', workspaceFile: null, basename: 'college', frame: { x: 40, y: 80, width: 900, height: 700 } },
    { folder: null, workspaceFile: '/projects/lab.code-workspace', basename: 'lab', frame: null },
];
const assigned = assignCodeWindows([
    { id: 'intern', title: 'notes.js — internship — Visual Studio Code', frame: { x: 12, y: 30, width: 1200, height: 800 } },
    { id: 'college', title: 'college — Visual Studio Code', frame: null },
    { id: 'lab', title: 'lab — Visual Studio Code', frame: null },
], projects);
assert(assigned.get('intern')?.data.folder === '/projects/internship', 'the internship window keeps its folder');
assert(assigned.get('college')?.data.folder === '/projects/college', 'the college window keeps its folder');
assert(assigned.get('lab')?.data.workspaceFile === '/projects/lab.code-workspace', 'a workspace file is kept');

const ambiguous = assignCodeWindows([
    { id: 'src', title: 'src — Visual Studio Code', frame: null },
], [
    { folder: '/a/src', workspaceFile: null, basename: 'src', frame: null },
    { folder: '/b/src', workspaceFile: null, basename: 'src', frame: null },
]);
assert(ambiguous.size === 0, 'two folders with the same name are not guessed');

const recent = assignCodeWindows([
    { id: 'cf', title: 'Welcome - codeforces - Visual Studio Code', frame: null },
    { id: 'ac', title: 'Variety.cpp - atcoder - Visual Studio Code', frame: null },
], [
    { folder: '/cp/codeforces', workspaceFile: null, basename: 'codeforces', frame: null, preferred: true },
    { folder: '/old/codeforces', workspaceFile: null, basename: 'codeforces', frame: null, preferred: false },
    { folder: '/cp/atcoder', workspaceFile: null, basename: 'atcoder', frame: null, preferred: true },
]);
assert(recent.get('cf')?.data.folder === '/cp/codeforces', 'the most recently used folder with that name is chosen');
assert(recent.get('ac')?.data.folder === '/cp/atcoder', 'a recently opened folder is found');
assert(codeTitleMatches('Variety.cpp - atcoder - Visual Studio Code', { folder: '/cp/atcoder' }), 'the launched window is recognised by its folder');
assert(!codeTitleMatches('Welcome - Visual Studio Code', { folder: '/cp/atcoder' }), 'an unrelated editor window is not taken');

const launched = planCodeLaunch('/snap/bin/code', ['--force-user-env', '%F', '--reuse-window'], {
    folder: '/projects/my project',
});
assert(launched?.argv?.join('\n') === '/snap/bin/code\n--force-user-env\n--new-window\n/projects/my project', 'the folder is one argument and reuse is not requested');
assert(planCodeLaunch('/snap/bin/code', [], { folder: '/tmp/../etc' }) === null, 'an unsafe folder is not launched');
assert(planCodeLaunch('/snap/bin/code', [], { workspaceFile: '/projects/lab.code-workspace' })?.argv?.at(-1) === '/projects/lab.code-workspace', 'a workspace file can be launched');

function codeWindow(key, title, context) {
    return {
        key,
        liveId: key,
        app: {
            desktopId: 'code_code.desktop',
            name: 'Visual Studio Code',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: 'Code',
            wmClassInstance: 'code',
        },
        title,
        windowType: 'normal',
        clientType: 'wayland',
        workspaceIndex: 0,
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
        context,
    };
}

const intern = { provider: 'vscode', data: { folder: '/projects/internship' } };
const college = { provider: 'vscode', data: { folder: '/projects/college' } };
const plan = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [
        codeWindow('saved-a', 'internship — Visual Studio Code', intern),
        codeWindow('saved-b', 'college — Visual Studio Code', college),
    ],
}, [
    codeWindow('live-a', 'other.js — internship — Visual Studio Code', intern),
], [{
    index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    connector: 'eDP-1', serial: 'ABC', primary: true, builtin: true,
}]);
const launches = plan.actions.filter(action => action.type === 'launch');
assert(launches.length === 1, 'only the missing project is opened');
assert(launches[0].context?.data.folder === '/projects/college', 'the launch opens the missing folder');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}
print('vscode tests passed');
