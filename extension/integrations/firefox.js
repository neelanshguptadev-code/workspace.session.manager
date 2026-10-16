/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { readFileContents } from '../core/files.js';
import { restorableUrls } from './chromium.js';
import { decodeMozLz4 } from './mozlz4.js';

const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

const ROOTS = [
    ['snap', 'firefox', 'common', '.mozilla', 'firefox'],
    ['.mozilla', 'firefox'],
];

export function firefoxKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('librewolf'))
        return null;
    if (id.includes('firefox'))
        return 'firefox';
    return null;
}

function safeProfileName(value) {
    if (typeof value !== 'string')
        return null;
    const name = value.trim();
    if (!PROFILE_NAME.test(name) || name.includes('..') || name.includes('/') || name.includes('\\'))
        return null;
    return name;
}

function pageTitle(title) {
    let text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    text = text.replace(/^[●•*]+\s*/, '');
    const parts = (text.includes(' — ') ? text.split(' — ') : text.split(' - '))
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length > 1 && /mozilla firefox|firefox/i.test(parts[parts.length - 1]))
        parts.pop();
    return parts.length ? parts[0].toLowerCase() : '';
}

function contextFor(profileName, urls) {
    const safeUrls = restorableUrls(urls);
    if (!safeUrls.length)
        return null;
    const data = { urls: safeUrls };
    const profile = safeProfileName(profileName);
    if (profile)
        data.profileName = profile;
    return { provider: 'firefox', data };
}

export function assignFirefoxWindows(gnomeWindows, sessions) {
    const assigned = new Map();
    const usable = (sessions ?? []).map(session => ({
        ...session,
        page: pageTitle(session.title),
    })).filter(session => session.page && session.urls?.length);
    const used = new Set();
    const pairs = [];
    gnomeWindows.forEach((gnome, gnomeIndex) => {
        const page = pageTitle(gnome.title);
        if (!page)
            return;
        usable.forEach((session, sessionIndex) => {
            if (page === session.page || page.startsWith(`${session.page} `))
                pairs.push({ gnomeIndex, sessionIndex, score: 80 + Math.min(session.page.length, 40) });
        });
    });
    pairs.sort((left, right) => right.score - left.score);
    for (const pair of pairs) {
        if (used.has(pair.gnomeIndex) || used.has(`s${pair.sessionIndex}`))
            continue;
        const rival = pairs.find(other => {
            return other.gnomeIndex === pair.gnomeIndex &&
                other.sessionIndex !== pair.sessionIndex &&
                pair.score - other.score < 10;
        });
        if (rival) {
            used.add(pair.gnomeIndex);
            continue;
        }
        const context = contextFor(usable[pair.sessionIndex].profileName, usable[pair.sessionIndex].urls);
        if (!context)
            continue;
        used.add(pair.gnomeIndex);
        used.add(`s${pair.sessionIndex}`);
        assigned.set(gnomeWindows[pair.gnomeIndex].id, context);
    }
    return assigned;
}

async function readBytes(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    const info = file.query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() <= 0 || info.get_size() > MAX_SESSION_BYTES)
        return null;
    const contents = await readFileContents(file);
    const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
    return { bytes, mtime: info.get_modification_date_time()?.to_unix() ?? 0 };
}

function parseIniProfiles(text, root) {
    const profiles = [];
    let name = '';
    let path = '';
    let relative = true;
    const flush = () => {
        const safeName = safeProfileName(name);
        if (!safeName || !path || path.includes('..') || path.includes('\0'))
            return;
        const full = relative ? GLib.build_filenamev([root, path]) : path;
        profiles.push({ name: safeName, path: full });
        name = '';
        path = '';
        relative = true;
    };
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
            flush();
            continue;
        }
        const split = trimmed.indexOf('=');
        if (split < 0)
            continue;
        const key = trimmed.slice(0, split).trim();
        const value = trimmed.slice(split + 1).trim();
        if (key === 'Name')
            name = value;
        else if (key === 'Path')
            path = value;
        else if (key === 'IsRelative')
            relative = value !== '0';
    }
    flush();
    return profiles;
}

function sessionFiles(profilePath) {
    return [
        GLib.build_filenamev([profilePath, 'sessionstore-backups', 'recovery.jsonlz4']),
        GLib.build_filenamev([profilePath, 'sessionstore.jsonlz4']),
    ];
}

function currentUrls(tab) {
    const entries = Array.isArray(tab?.entries) ? tab.entries : [];
    const index = Number.isInteger(tab?.index) ? tab.index - 1 : entries.length - 1;
    const entry = entries[index] ?? entries[entries.length - 1];
    return {
        url: typeof entry?.url === 'string' ? entry.url : '',
        title: typeof entry?.title === 'string' ? entry.title : '',
    };
}

function sessionsFromStore(parsed, profileName) {
    const sessions = [];
    for (const window of parsed?.windows ?? []) {
        const tabs = Array.isArray(window?.tabs) ? window.tabs : [];
        const selected = Number.isInteger(window?.selected) ? window.selected - 1 : 0;
        const urls = [];
        let title = '';
        tabs.forEach((tab, index) => {
            const current = currentUrls(tab);
            if (current.url && !urls.includes(current.url))
                urls.push(current.url);
            if (index === selected && current.title)
                title = current.title;
        });
        if (urls.length)
            sessions.push({ profileName, title, urls });
    }
    return sessions;
}

export async function loadFirefoxSessions() {
    const home = GLib.get_home_dir();
    const sessions = [];
    for (const parts of ROOTS) {
        const root = GLib.build_filenamev([home, ...parts]);
        const ini = await readBytes(GLib.build_filenamev([root, 'profiles.ini']));
        if (!ini)
            continue;
        let text = '';
        try {
            text = new TextDecoder().decode(ini.bytes);
        } catch {
            continue;
        }
        for (const profile of parseIniProfiles(text, root)) {
            let newest = null;
            for (const path of sessionFiles(profile.path)) {
                const file = await readBytes(path);
                if (file && (!newest || file.mtime >= newest.mtime))
                    newest = file;
            }
            if (!newest)
                continue;
            const decoded = decodeMozLz4(newest.bytes);
            if (!decoded)
                continue;
            try {
                const parsed = JSON.parse(new TextDecoder().decode(decoded));
                sessions.push(...sessionsFromStore(parsed, profile.name));
            } catch {
                // One unreadable profile does not discard the others.
            }
        }
    }
    return sessions;
}

export async function enrichFirefoxContexts(windows) {
    const pending = [];
    windows.forEach((windowRecord, index) => {
        if (windowRecord.context || !firefoxKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass))
            return;
        pending.push({ index, id: index, title: windowRecord.title });
    });
    if (!pending.length)
        return windows;
    let assigned = new Map();
    try {
        assigned = assignFirefoxWindows(pending, await loadFirefoxSessions());
    } catch {
        return windows;
    }
    if (assigned.size === 0)
        return windows;
    return windows.map((windowRecord, index) => {
        const context = assigned.get(index);
        return context ? { ...windowRecord, context } : windowRecord;
    });
}

export async function attachFirefoxContexts(records, warnings) {
    const enriched = await enrichFirefoxContexts(records);
    let unmatched = 0;
    records.forEach((record, index) => {
        if (!firefoxKind(record.app?.desktopId, record.app?.wmClass))
            return;
        if (enriched[index]?.context)
            record.context = enriched[index].context;
        else
            unmatched += 1;
    });
    if (unmatched > 0)
        warnings?.push('Some Firefox windows could not be matched to their tabs, so those tabs were not saved');
}

export function planFirefoxLaunch(executable, data) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const urls = restorableUrls(data?.urls);
    if (!urls.length)
        return null;
    const argv = [executable];
    const profile = safeProfileName(data?.profileName);
    if (profile)
        argv.push('-P', profile);
    argv.push('--new-window', ...urls);
    return { argv };
}
