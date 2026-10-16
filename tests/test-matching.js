/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import System from 'system';

import { planMerge, progressText, scoreMatch, summarizePlan } from '../extension/core/matching.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

function windowRecord(overrides) {
    return {
        liveId: overrides.liveId ?? null,
        key: overrides.key,
        app: {
            desktopId: 'code.desktop',
            name: 'Visual Studio Code',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: 'code',
            wmClassInstance: 'code',
            ...overrides.app,
        },
        title: 'project — Visual Studio Code',
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
        context: null,
        ...overrides,
        app: {
            desktopId: 'code.desktop',
            name: 'Visual Studio Code',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: 'code',
            wmClassInstance: 'code',
            ...overrides.app,
        },
        state: {
            maximizedHorizontally: false,
            maximizedVertically: false,
            fullscreen: false,
            minimized: false,
            above: false,
            ...overrides.state,
        },
    };
}

const monitors = [{
    index: 0,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    connector: 'eDP-1',
    serial: 'ABC',
    primary: true,
    builtin: true,
}];

const sessionBase = {
    focusedWindowKey: 'saved-a',
    environment: { dynamicWorkspaces: true },
    activeWorkspaceIndex: 1,
};

const unique = planMerge({
    ...sessionBase,
    windows: [windowRecord({ key: 'saved-a', workspaceIndex: 1 })],
}, [
    windowRecord({
        liveId: 11,
        key: 'live-a',
        title: 'something else',
        workspaceIndex: 0,
    }),
], monitors);
assert(unique.actions.length === 1, 'unique app should yield one action');
assert(unique.actions[0].type === 'move', `unique app should move, got ${unique.actions[0]?.type}`);
assert(unique.actions[0].workspaceIndex === 1, 'unique app keeps saved workspace');
assert(unique.summary.unrelated === 0, 'the only live window was claimed');

const titleMatch = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', title: 'intern — Visual Studio Code', workspaceIndex: 2 }),
        windowRecord({ key: 'saved-b', title: 'college — Visual Studio Code', workspaceIndex: 0 }),
    ],
}, [
    windowRecord({ liveId: 21, key: 'live-b', title: 'college — Visual Studio Code', workspaceIndex: 3 }),
    windowRecord({ liveId: 20, key: 'live-a', title: 'intern — Visual Studio Code', workspaceIndex: 0 }),
], monitors);
const intern = titleMatch.actions.find(action => action.savedKey === 'saved-a');
const college = titleMatch.actions.find(action => action.savedKey === 'saved-b');
assert(intern?.liveId === 20, 'intern project should match intern window');
assert(college?.liveId === 21, 'college project should match college window');
assert(intern?.type === 'move' && college?.type === 'move', 'both titled windows should move');

const firefoxApp = {
    desktopId: 'firefox.desktop',
    name: 'Firefox',
    wmClass: 'firefox',
    wmClassInstance: 'firefox',
};
const ambiguous = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', title: 'Mozilla Firefox', app: firefoxApp }),
        windowRecord({ key: 'saved-b', title: 'Mozilla Firefox', app: firefoxApp }),
    ],
}, [
    windowRecord({
        liveId: 31,
        key: 'live-a',
        title: 'Mozilla Firefox',
        app: { desktopId: 'firefox.desktop', name: 'Firefox', wmClass: 'firefox', wmClassInstance: 'firefox' },
    }),
    windowRecord({
        liveId: 32,
        key: 'live-b',
        title: 'Mozilla Firefox',
        app: { desktopId: 'firefox.desktop', name: 'Firefox', wmClass: 'firefox', wmClassInstance: 'firefox' },
    }),
], monitors);
assert(ambiguous.actions.every(action => action.type === 'skip'), 'identical firefox windows should be skipped');
assert(ambiguous.summary.unrelated === 2, 'ambiguous restore must not claim live windows');

const missing = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', app: { desktopId: 'code.desktop' } }),
        windowRecord({
            key: 'saved-b',
            app: { desktopId: 'org.gnome.Nautilus.desktop', name: 'Files', wmClass: 'org.gnome.Nautilus' },
        }),
    ],
}, [
    windowRecord({ liveId: 41, key: 'live-a' }),
], monitors);
assert(missing.actions.find(action => action.savedKey === 'saved-a')?.type !== 'skip', 'code window is open');
assert(missing.actions.find(action => action.savedKey === 'saved-b')?.type === 'launch', 'files window should be launched');
assert(missing.summary.launch === 1, 'one application should be opened');
assert(missing.summary.unrelated === 0, 'no leftover after unique code match');

const noDesktop = planMerge({
    ...sessionBase,
    windows: [windowRecord({
        key: 'saved-a',
        app: {
            desktopId: null,
            name: 'Unknown',
            wmClass: 'unknown',
            wmClassInstance: 'unknown',
        },
    })],
}, [], monitors);
assert(noDesktop.actions[0].type === 'skip', 'a window without a desktop file must not be launched');
assert(!noDesktop.actions.some(action => action.type === 'launch'), 'no launch without a desktop id');

const closedFirefox = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', title: 'Mozilla Firefox', app: firefoxApp }),
        windowRecord({ key: 'saved-b', title: 'Mozilla Firefox', app: firefoxApp }),
    ],
}, [], monitors);
assert(closedFirefox.summary.launch === 2, 'two missing Firefox windows should both be opened');

const oneFirefox = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', title: 'Mozilla Firefox', app: firefoxApp, workspaceIndex: 1 }),
        windowRecord({ key: 'saved-b', title: 'Mozilla Firefox', app: firefoxApp, workspaceIndex: 2 }),
    ],
}, [
    windowRecord({
        liveId: 33,
        key: 'live-a',
        title: 'Mozilla Firefox',
        workspaceIndex: 0,
        app: { desktopId: 'firefox.desktop', name: 'Firefox', wmClass: 'firefox', wmClassInstance: 'firefox' },
    }),
], monitors);
assert(oneFirefox.summary.launch === 1, 'one open Firefox should leave one launch');
assert(oneFirefox.actions.filter(action => action.type === 'move' || action.type === 'keep').length === 1, 'the open Firefox should be reused');

const hostileId = planMerge({
    ...sessionBase,
    windows: [windowRecord({
        key: 'saved-a',
        app: { desktopId: '../evil.desktop', name: 'Evil' },
    })],
}, [], monitors);
assert(hostileId.actions[0].type === 'skip', 'a path-like desktop id must not be launched');

const discord = windowRecord({
    liveId: 51,
    key: 'live-discord',
    title: 'Discord',
    app: { desktopId: 'discord.desktop', name: 'Discord', wmClass: 'discord', wmClassInstance: 'discord' },
});
const mergeUnrelated = planMerge({
    ...sessionBase,
    windows: [windowRecord({ key: 'saved-a' })],
}, [
    windowRecord({ liveId: 50, key: 'live-a' }),
    discord,
], monitors);
assert(mergeUnrelated.summary.unrelated === 1, 'discord should remain unrelated');
assert(!mergeUnrelated.actions.some(action => action.liveId === 51), 'plan must not mention discord');

const keep = planMerge({
    ...sessionBase,
    windows: [windowRecord({ key: 'saved-a', workspaceIndex: 0 })],
}, [
    windowRecord({ liveId: 61, key: 'live-a', workspaceIndex: 0 }),
], monitors);
assert(keep.actions[0].type === 'keep', 'already placed window should be kept');

const missingMonitor = [{
    index: 0,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    scale: 1,
    connector: 'HDMI-1',
    serial: 'OTHER',
    primary: true,
    builtin: false,
}];
const fallback = planMerge({
    ...sessionBase,
    windows: [windowRecord({
        key: 'saved-a',
        workspaceIndex: 0,
        monitorSerial: 'GONE',
        monitorConnector: 'DP-1',
        monitorIndex: 1,
    })],
}, [
    windowRecord({ liveId: 71, key: 'live-a', workspaceIndex: 0, monitorIndex: 0 }),
], missingMonitor);
assert(fallback.actions[0].type === 'keep', `missing monitor already on primary should stay, got ${fallback.actions[0]?.type}`);

const movedLive = windowRecord({
    liveId: 81,
    key: 'live-a',
    workspaceIndex: 1,
    title: 'intern — Visual Studio Code',
});
const again = planMerge({
    ...sessionBase,
    windows: [windowRecord({
        key: 'saved-a',
        title: 'intern — Visual Studio Code',
        workspaceIndex: 1,
    })],
}, [movedLive], monitors);
assert(again.actions[0].type === 'keep', 'a second restore of the same placement should keep the window');

const shortTitle = planMerge({
    ...sessionBase,
    windows: [
        windowRecord({ key: 'saved-a', title: 'mail' }),
        windowRecord({ key: 'saved-b', title: 'docs' }),
    ],
}, [
    windowRecord({ liveId: 91, key: 'live-a', title: 'mail and more — Visual Studio Code' }),
    windowRecord({ liveId: 92, key: 'live-b', title: 'docs folder — Visual Studio Code' }),
], monitors);
assert(shortTitle.actions.every(action => action.type === 'skip'), 'a short shared title fragment must not pick a window');

const otherApp = scoreMatch(
    windowRecord({ key: 'saved-a' }),
    discord,
);
assert(otherApp.score === 0, 'different applications must not match');

const text = summarizePlan(titleMatch);
assert(text.includes('Nothing will be closed'), `summary should mention safety: ${text}`);
assert(progressText({ type: 'launch', label: 'Text Editor' }, 2, 5) === 'Opening Text Editor, 2 of 5', 'launch progress names the application');
assert(progressText({ type: 'move', label: 'Files' }, 1, 5) === 'Moving Files, 1 of 5', 'move progress names the application');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}

print(`ok ${titleMatch.actions.length} merge actions covered`);
