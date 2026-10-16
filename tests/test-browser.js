/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import System from 'system';

import { planMerge } from '../extension/core/matching.js';
import {
    assignChromiumWindows,
    browserKind,
    planChromiumLaunch,
    restorableUrls,
    sanitizeProfileDirectory,
    urlsCoveredBySession,
} from '../extension/integrations/chromium.js';
import { parseChromiumSession } from '../extension/integrations/snss.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function bytesOf(size, write) {
    const out = new Uint8Array(size);
    write(new DataView(out.buffer));
    return out;
}

function i32(value) {
    return bytesOf(4, view => view.setInt32(0, value, true));
}

function u32(value) {
    return bytesOf(4, view => view.setUint32(0, value, true));
}

function rawPair(first, second) {
    return concat([i32(first), i32(second)]);
}

function command(id, payload) {
    const framed = bytesOf(3 + payload.length, view => {
        view.setUint16(0, 1 + payload.length, true);
        view.setUint8(2, id);
    });
    framed.set(payload, 3);
    return framed;
}

function pickle(body) {
    return concat([u32(body.length), body]);
}

function padded(bytes) {
    const extra = (4 - (bytes.length % 4)) % 4;
    return extra === 0 ? bytes : concat([bytes, new Uint8Array(extra)]);
}

function utf8(text) {
    const encoded = new TextEncoder().encode(text);
    return padded(concat([i32(encoded.length), encoded]));
}

function utf16(text) {
    const encoded = bytesOf(text.length * 2, view => {
        for (let index = 0; index < text.length; index += 1)
            view.setUint16(index * 2, text.charCodeAt(index), true);
    });
    return padded(concat([i32(text.length), encoded]));
}

function navigation(tabId, index, url, title) {
    return command(6, pickle(concat([i32(tabId), i32(index), utf8(url), utf16(title)])));
}

function sessionBytes() {
    const header = bytesOf(8, view => {
        view.setUint8(0, 0x53);
        view.setUint8(1, 0x4e);
        view.setUint8(2, 0x53);
        view.setUint8(3, 0x53);
        view.setInt32(4, 1, true);
    });
    return concat([
        header,
        command(0, rawPair(7, 11)),
        command(2, rawPair(11, 0)),
        command(7, rawPair(11, 0)),
        navigation(11, 1, 'https://example.com/older', 'Older page'),
        navigation(11, 0, 'https://example.com/', 'Example Domain'),
        command(0, rawPair(7, 12)),
        command(2, rawPair(12, 1)),
        command(7, rawPair(12, 0)),
        navigation(12, 0, 'javascript:alert(1)', 'Script tab'),
        command(8, rawPair(7, 0)),
    ]);
}

const parsed = parseChromiumSession(sessionBytes());
assert(parsed?.length === 1, 'session has one window');
assert(parsed?.[0].title === 'Example Domain', 'selected tab title is kept');
assert(parsed?.[0].urls[0] === 'https://example.com/', 'current url is kept');
assert(!parsed?.[0].urls.includes('https://example.com/older'), 'back-forward history is not kept');
assert(parsed?.[0].urls.includes('javascript:alert(1)'), 'parser does not invent a scheme filter');
assert(parseChromiumSession(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null, 'non-session file is ignored');

assert(browserKind('brave_brave.desktop', 'brave-browser') === 'brave', 'brave desktop id');
assert(browserKind('chromium.desktop', 'chromium') === 'chromium', 'chromium is not classified as chrome');
assert(browserKind('code.desktop', 'code') === null, 'editor is not a browser');
assert(sanitizeProfileDirectory('Profile 1') === 'Profile 1', 'profile names may contain a space');
assert(sanitizeProfileDirectory('../Default') === null, 'profile path traversal is rejected');
assert(sanitizeProfileDirectory('Default/../../etc') === null, 'profile separators are rejected');

const safeUrls = restorableUrls([
    'https://example.com/a',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:pass@example.com/secret',
    'https://example.com/a',
]);
assert(safeUrls.length === 1 && safeUrls[0] === 'https://example.com/a', 'only http(s) urls without credentials are restorable');

const direct = planChromiumLaunch('/snap/bin/brave', {
    profileDirectory: 'Profile 1',
    urls: ['https://example.com/a', 'javascript:alert(1)', 'https://example.com/b'],
}, new Set());
assert(direct?.argv?.[0] === '/snap/bin/brave', 'executable stays one argument');
assert(direct?.argv?.[1] === '--profile-directory=Profile 1', 'profile is one argument');
assert(direct?.argv?.[2] === '--new-window', 'tabs open in a new window');
assert(direct?.argv?.slice(3).join(' ') === 'https://example.com/a https://example.com/b', 'hostile urls are omitted');

assert(planChromiumLaunch('/snap/bin/brave', {
    profileDirectory: '../Default',
    urls: ['https://example.com/'],
}, new Set()) === null, 'unsafe profile is not launched');

const claimed = new Set();
const fallback = planChromiumLaunch('/snap/bin/brave', {
    profileDirectory: 'Default',
    urls: ['javascript:alert(1)'],
}, claimed);
assert(fallback?.argv?.at(-1) === '--restore-last-session', 'profile without safe urls uses the browser session');
assert(!fallback?.argv?.some(arg => String(arg).includes('javascript:')), 'script urls are not passed through');
assert(planChromiumLaunch('/snap/bin/brave', { profileDirectory: 'Default', urls: [] }, claimed)?.skip === true, 'one profile is restored once');

const openTabs = [{ title: 'Example', urls: ['https://example.com/a/', 'https://example.com/b'] }];
assert(urlsCoveredBySession(['https://example.com/a', 'https://example.com/b/'], openTabs), 'saved tabs already in the closed window are covered');
assert(!urlsCoveredBySession(['https://example.com/a', 'https://example.com/missing'], openTabs), 'a tab the window does not have is not covered');
const restored = planChromiumLaunch('/snap/bin/brave', {
    profileDirectory: 'Default',
    urls: ['https://example.com/a/', 'https://example.com/b'],
}, new Set(), { sessionWindows: openTabs });
assert(restored?.argv?.at(-1) === '--restore-last-session', 'a closed window is restored once');
assert(!restored?.argv?.some(arg => String(arg).startsWith('https://')), 'covered tabs are not opened a second time');
const added = planChromiumLaunch('/snap/bin/brave', {
    profileDirectory: 'Profile 1',
    urls: ['https://example.com/missing'],
}, new Set(), { sessionWindows: openTabs });
assert(added?.argv?.includes('https://example.com/missing'), 'a tab that is not already open is still requested');

const profiles = [
    {
        directory: 'Default',
        displayName: 'Neelansh-BITS',
        windows: [{ title: 'Inbox mail example', urls: ['https://mail.example/'] }],
    },
    {
        directory: 'Defautl',
        displayName: 'Personal',
        windows: [{ title: 'Other personal page', urls: ['https://personal.example/'] }],
    },
    {
        directory: 'Profile 1',
        displayName: 'Neelansh-Personal',
        windows: [{ title: 'Work board page', urls: ['https://work.example/'] }],
    },
];
const assigned = assignChromiumWindows([
    { id: 'bits', title: 'Inbox mail example - Neelansh-BITS - Brave' },
    { id: 'work', title: 'Work board page - Neelansh-Personal - Brave' },
    { id: 'home', title: 'Other personal page - Personal - Brave' },
], profiles);
assert(assigned.get('bits')?.data.profileDirectory === 'Default', 'profile name selects Default');
assert(assigned.get('bits')?.data.urls[0] === 'https://mail.example/', 'Default keeps its own tabs');
assert(assigned.get('work')?.data.profileDirectory === 'Profile 1', 'longer profile name wins over Personal');
assert(assigned.get('home')?.data.profileDirectory === 'Defautl', 'Personal stays on its own window');

const shortTitle = assignChromiumWindows([
    { id: 'whatsapp', title: '(4) WhatsApp - Brave' },
    { id: 'chat', title: 'ChatGPT - Brave' },
], [
    { directory: 'Profile 1', displayName: 'Neelansh-Personal', windows: [{ title: '(4) WhatsApp', urls: ['https://web.whatsapp.com/'] }] },
    { directory: 'Profile 2', displayName: 'timepass', windows: [{ title: 'ChatGPT', urls: ['https://chatgpt.com/'] }] },
    { directory: 'Defautl', displayName: 'Personal', windows: [{ title: 'Gmail', urls: ['https://mail.google.com/'] }] },
]);
assert(shortTitle.get('chat')?.data.profileDirectory === 'Profile 2', 'a short page title still finds its profile');
assert(shortTitle.get('whatsapp')?.data.profileDirectory === 'Profile 1', 'titles without the profile name still match');
assert(assignChromiumWindows([{ id: 'x', title: 'Chat - Something else - Brave' }], [
    { directory: 'Profile 2', displayName: 'timepass', windows: [{ title: 'Chat', urls: ['https://chat.example/'] }] },
]).size === 0, 'a short title does not match a longer page title');

function braveWindow(key, title, context) {
    return {
        key,
        app: {
            desktopId: 'brave_brave.desktop',
            name: 'Brave',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: 'brave-browser',
            wmClassInstance: 'brave-browser',
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

const bits = {
    provider: 'chromium',
    data: { profileDirectory: 'Default', urls: ['https://mail.example/'] },
};
const work = {
    provider: 'chromium',
    data: { profileDirectory: 'Profile 1', urls: ['https://work.example/'] },
};
const plan = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [
        braveWindow('saved-a', 'Inbox mail example - Neelansh-BITS - Brave', bits),
        braveWindow('saved-b', 'Work board page - Neelansh-Personal - Brave', work),
    ],
}, [
    { ...braveWindow('live-a', 'Inbox mail example - Neelansh-BITS - Brave', bits), liveId: 1 },
], [{
    index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    connector: 'eDP-1', serial: 'ABC', primary: true, builtin: true,
}]);
const launch = plan.actions.filter(action => action.type === 'launch');
assert(launch.length === 1, 'only the missing Brave window is opened');
assert(launch[0].context?.data.profileDirectory === 'Profile 1', 'launch keeps the missing profile');
assert(launch[0].context?.data.urls[0] === 'https://work.example/', 'launch keeps that window’s tabs');
assert(plan.actions.some(action => action.type === 'launch' && action.context?.data.urls?.[0] === 'https://mail.example/') === false, 'the open profile is not launched again');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}
print('browser tests passed');
