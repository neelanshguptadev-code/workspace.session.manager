/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const MAX_COMMANDS = 20000;
const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 300;
const MAX_TABS = 30;

function asBytes(input) {
    if (input instanceof Uint8Array)
        return input;
    return null;
}

function payloadView(bytes, offset, length) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

function align(offset) {
    return (offset + 3) & ~3;
}

function readI32(view, offset, length) {
    offset = align(offset);
    if (offset + 4 > length)
        throw new Error('truncated integer');
    return [view.getInt32(offset, true), offset + 4];
}

function readBytes(view, offset, length) {
    let size;
    [size, offset] = readI32(view, offset, length);
    if (size < 0 || size > 2_000_000 || offset + size > length)
        throw new Error('truncated bytes');
    return [offset, size, offset + size];
}

function decodeUtf8(bytes, offset, size) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(offset, offset + size));
}

function decodeUtf16(bytes, offset, units) {
    const size = units * 2;
    return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(offset, offset + size));
}

function readString16(bytes, base, view, offset, length) {
    let units;
    [units, offset] = readI32(view, offset, length);
    if (units < 0 || units > 100000 || offset + units * 2 > length)
        throw new Error('truncated title');
    const text = decodeUtf16(bytes, base + offset, units).replace(/\u0000/g, '').slice(0, MAX_TITLE_LENGTH);
    return [text, offset + units * 2];
}

/**
 * Read the current tab of each window from a Chromium SNSS session file.
 * History, page state, and referrers are not kept.
 * Returns null when the file is not a session snapshot.
 */
export function parseChromiumSession(input) {
    const bytes = asBytes(input);
    if (!bytes || bytes.length < 8)
        return null;
    if (bytes[0] !== 0x53 || bytes[1] !== 0x4e || bytes[2] !== 0x53 || bytes[3] !== 0x53)
        return null;

    const nav = new Map();
    const tabWindow = new Map();
    const tabIndex = new Map();
    const selectedNav = new Map();
    const selectedTab = new Map();
    let pos = 8;
    let commands = 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    while (pos + 2 <= bytes.length && commands < MAX_COMMANDS) {
        const size = view.getUint16(pos, true);
        pos += 2;
        if (size === 0 || pos + size > bytes.length)
            break;
        const command = bytes[pos];
        const payloadOffset = pos + 1;
        const payloadLength = size - 1;
        pos += size;
        commands += 1;
        if (payloadLength < 8)
            continue;
        const payload = payloadView(bytes, payloadOffset, payloadLength);
        if (command === 0 || command === 2 || command === 7 || command === 8) {
            const first = payload.getInt32(0, true);
            const second = payload.getInt32(4, true);
            if (command === 0)
                tabWindow.set(second, first);
            else if (command === 2)
                tabIndex.set(first, second);
            else if (command === 7)
                selectedNav.set(first, second);
            else
                selectedTab.set(first, second);
            continue;
        }
        if (command !== 6 || payloadLength < 12)
            continue;
        const pickleSize = payload.getUint32(0, true);
        if (pickleSize < 8 || pickleSize > payloadLength - 4)
            continue;
        const bodyOffset = payloadOffset + 4;
        const body = payloadView(bytes, bodyOffset, pickleSize);
        try {
            let offset = 0;
            let tabId;
            let index;
            let urlOffset;
            let urlSize;
            let title;
            [tabId, offset] = readI32(body, offset, pickleSize);
            [index, offset] = readI32(body, offset, pickleSize);
            [urlOffset, urlSize, offset] = readBytes(body, offset, pickleSize);
            const url = decodeUtf8(bytes, bodyOffset + urlOffset, urlSize).slice(0, MAX_URL_LENGTH);
            [title, offset] = readString16(bytes, bodyOffset, body, offset, pickleSize);
            const entries = nav.get(tabId) ?? new Map();
            entries.set(index, { url, title });
            nav.set(tabId, entries);
        } catch {
            // One damaged navigation entry does not discard the rest of the file.
        }
    }

    const grouped = new Map();
    for (const [tabId, entries] of nav) {
        const windowId = tabWindow.get(tabId);
        if (windowId === undefined || entries.size === 0)
            continue;
        const indexes = [...entries.keys()];
        const selectedIndex = selectedNav.has(tabId) ? selectedNav.get(tabId) : Math.max(...indexes);
        const current = entries.get(selectedIndex) ?? entries.get(Math.max(...indexes));
        if (!current)
            continue;
        const tabs = grouped.get(windowId) ?? [];
        tabs.push({
            index: tabIndex.get(tabId) ?? tabs.length,
            url: current.url,
            title: current.title,
            selected: selectedTab.get(windowId) === (tabIndex.get(tabId) ?? -1),
        });
        grouped.set(windowId, tabs);
    }

    return [...grouped.values()].map(tabs => {
        tabs.sort((left, right) => left.index - right.index);
        const selected = tabs.find(tab => tab.selected) ?? tabs[0];
        const urls = [];
        for (const tab of tabs) {
            if (urls.length >= MAX_TABS)
                break;
            if (!urls.includes(tab.url))
                urls.push(tab.url);
        }
        return {
            title: selected?.title ?? '',
            urls,
        };
    });
}
