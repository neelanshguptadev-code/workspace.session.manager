/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import { readFileContents } from '../core/files.js';
import { parseChromiumSession } from './snss.js';

const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.desktop$/;
const PROFILE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_URLS = 30;

const USER_DATA = {
    brave: [
        ['.config', 'BraveSoftware', 'Brave-Browser'],
        ['snap', 'brave', 'current', '.config', 'BraveSoftware', 'Brave-Browser'],
    ],
    chrome: [
        ['.config', 'google-chrome'],
    ],
    chromium: [
        ['.config', 'chromium'],
        ['snap', 'chromium', 'current', '.config', 'chromium'],
    ],
    edge: [
        ['.config', 'microsoft-edge'],
    ],
    vivaldi: [
        ['.config', 'vivaldi'],
    ],
};

export function browserKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('brave'))
        return 'brave';
    if (id.includes('vivaldi'))
        return 'vivaldi';
    if (id.includes('msedge') || id.includes('microsoft-edge'))
        return 'edge';
    if (id.includes('chromium'))
        return 'chromium';
    if (id.includes('chrome'))
        return 'chrome';
    return null;
}

export function sanitizeProfileDirectory(value) {
    if (typeof value !== 'string')
        return null;
    const profile = value.trim();
    if (!PROFILE_DIRECTORY.test(profile))
        return null;
    if (profile.includes('..') || profile.includes('/') || profile.includes('\\'))
        return null;
    return profile;
}

export function restorableUrls(urls) {
    if (!Array.isArray(urls))
        return [];
    const kept = [];
    for (const url of urls) {
        if (kept.length >= MAX_URLS)
            break;
        if (!isRestorableUrl(url) || kept.includes(url))
            continue;
        kept.push(url);
    }
    return kept;
}

function canonicalUrl(url) {
    const match = /^(https?:\/\/)([^/?#]+)([^#]*)/i.exec(typeof url === 'string' ? url.trim() : '');
    if (!match)
        return '';
    return `${match[1].toLowerCase()}${match[2].toLowerCase()}${match[3].replace(/\/+$/, '')}`;
}

/**
 * True when every saved address is already a current tab in one browser window.
 * Closing the window leaves those tabs in the browser's own session, so passing
 * them on the command line opens a second copy.
 */
export function urlsCoveredBySession(wanted, sessionWindows) {
    const urls = restorableUrls(wanted).map(canonicalUrl).filter(Boolean);
    if (!urls.length || !Array.isArray(sessionWindows))
        return false;
    return sessionWindows.some(win => {
        const have = new Set(restorableUrls(win?.urls).map(canonicalUrl));
        return urls.every(url => have.has(url));
    });
}

function isRestorableUrl(url) {
    if (typeof url !== 'string' || url.length === 0 || url.length > 2000)
        return false;
    if (/[\u0000-\u001f\u007f\s]/.test(url))
        return false;
    const match = /^(https?):\/\/([^/?#]*)([^]*)$/i.exec(url);
    if (!match)
        return false;
    const authority = match[2];
    if (!authority || authority.includes('@') || authority.includes('\\'))
        return false;
    return true;
}

function normalizeText(value) {
    return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

function nameInTitle(title, name) {
    const profile = normalizeText(name);
    const windowTitle = ` ${normalizeText(title)} `;
    if (profile.length < 2)
        return false;
    return windowTitle.includes(` - ${profile} - `) || windowTitle.endsWith(` - ${profile} `);
}

function tabTitleInWindow(title, tabTitle) {
    const windowTitle = normalizeText(title);
    const page = normalizeText(tabTitle);
    if (page.length < 2)
        return false;
    if (windowTitle === page)
        return true;
    for (const separator of [' - ', ' — ']) {
        if (!windowTitle.startsWith(`${page}${separator}`))
            continue;
        const suffix = windowTitle.slice(page.length + separator.length);
        if (!suffix.includes(' - ') && !suffix.includes(' — '))
            return true;
        if (page.length >= 8)
            return true;
    }
    return false;
}

function contextFor(session) {
    const profileDirectory = sanitizeProfileDirectory(session.directory);
    if (!profileDirectory)
        return null;
    return {
        provider: 'chromium',
        data: {
            profileDirectory,
            urls: restorableUrls(session.urls),
        },
    };
}

function scoreAssignment(title, session, profileWindowCount) {
    const nameHit = session.displayName && nameInTitle(title, session.displayName);
    const titleHit = session.title && tabTitleInWindow(title, session.title);
    let score = 0;
    if (nameHit)
        score += profileWindowCount === 1 ? 60 + Math.min(session.displayName.length, 80) : 30;
    if (titleHit)
        score += 50 + Math.min(session.title.length, 80);
    return score;
}

/**
 * Pair open browser windows with saved profile windows.
 * gnomeWindows are { id, title }. profiles are { directory, displayName, windows }.
 */
export function assignChromiumWindows(gnomeWindows, profiles) {
    const assigned = new Map();
    const counts = new Map();
    const sessionWindows = [];
    for (const profile of profiles ?? []) {
        const directory = sanitizeProfileDirectory(profile.directory);
        if (!directory)
            continue;
        const windows = profile.windows?.length ? profile.windows : [{ title: '', urls: [] }];
        counts.set(directory, windows.length);
        for (const win of windows) {
            sessionWindows.push({
                directory,
                displayName: typeof profile.displayName === 'string' ? profile.displayName : '',
                title: typeof win.title === 'string' ? win.title : '',
                urls: win.urls ?? [],
            });
        }
    }

    const pairs = [];
    gnomeWindows.forEach((gnome, gnomeIndex) => {
        sessionWindows.forEach((session, sessionIndex) => {
            const score = scoreAssignment(gnome.title, session, counts.get(session.directory) ?? 1);
            if (score >= 40)
                pairs.push({ gnomeIndex, sessionIndex, score });
        });
    });
    pairs.sort((left, right) => right.score - left.score || left.sessionIndex - right.sessionIndex);
    const usedGnome = new Set();
    const usedSession = new Set();
    for (const pair of pairs) {
        if (usedGnome.has(pair.gnomeIndex) || usedSession.has(pair.sessionIndex))
            continue;
        const context = contextFor(sessionWindows[pair.sessionIndex]);
        if (!context)
            continue;
        usedGnome.add(pair.gnomeIndex);
        usedSession.add(pair.sessionIndex);
        assigned.set(gnomeWindows[pair.gnomeIndex].id, context);
    }
    return assigned;
}

function homePath(parts) {
    return GLib.build_filenamev([GLib.get_home_dir(), ...parts]);
}

function fileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

function sessionStamp(name) {
    const match = /^Session_(\d+)$/.exec(name);
    return match ? match[1] : '';
}

function newerStamp(left, right) {
    if (left.length !== right.length)
        return left.length > right.length;
    return left > right;
}

function listChildren(path) {
    const directory = Gio.File.new_for_path(path);
    if (!directory.query_exists(null))
        return [];
    const enumerator = directory.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    const names = [];
    try {
        while (true) {
            const info = enumerator.next_file(null);
            if (!info)
                break;
            names.push({ name: info.get_name(), directory: info.get_file_type() === Gio.FileType.DIRECTORY });
        }
    } finally {
        enumerator.close(null);
    }
    return names;
}

function newestSessionStamp(userDataDir) {
    let best = '';
    for (const child of listChildren(userDataDir)) {
        if (!child.directory || !sanitizeProfileDirectory(child.name))
            continue;
        const sessions = GLib.build_filenamev([userDataDir, child.name, 'Sessions']);
        for (const file of listChildren(sessions)) {
            const stamp = sessionStamp(file.name);
            if (stamp && newerStamp(stamp, best))
                best = stamp;
        }
    }
    return best;
}

function chooseUserDataDir(kind) {
    const candidates = (USER_DATA[kind] ?? [])
        .map(homePath)
        .filter(fileExists);
    let chosen = null;
    let chosenStamp = '';
    for (const candidate of candidates) {
        const stamp = newestSessionStamp(candidate);
        if (!chosen || newerStamp(stamp, chosenStamp)) {
            chosen = candidate;
            chosenStamp = stamp;
        }
    }
    return chosen;
}

async function readBytes(path) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() <= 0 || info.get_size() > MAX_SESSION_BYTES)
        return null;
    const contents = await readFileContents(file);
    if (contents instanceof Uint8Array)
        return contents;
    try {
        return new Uint8Array(contents);
    } catch {
        return null;
    }
}

async function profileDisplayNames(userDataDir) {
    const names = new Map();
    try {
        const bytes = await readBytes(GLib.build_filenamev([userDataDir, 'Local State']));
        if (!bytes)
            return names;
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        const cache = parsed?.profile?.info_cache;
        if (!cache || typeof cache !== 'object')
            return names;
        for (const [directory, info] of Object.entries(cache)) {
            const profile = sanitizeProfileDirectory(directory);
            const name = typeof info?.name === 'string' ? info.name.trim().slice(0, 80) : '';
            if (profile && name)
                names.set(profile, name);
        }
    } catch {
        return names;
    }
    return names;
}

async function readProfileWindows(userDataDir, directory) {
    const sessions = GLib.build_filenamev([userDataDir, directory, 'Sessions']);
    let bestName = '';
    let bestStamp = '';
    for (const file of listChildren(sessions)) {
        const stamp = sessionStamp(file.name);
        if (stamp && newerStamp(stamp, bestStamp)) {
            bestStamp = stamp;
            bestName = file.name;
        }
    }
    if (!bestName)
        return [];
    try {
        const bytes = await readBytes(GLib.build_filenamev([sessions, bestName]));
        if (!bytes)
            return [];
        return parseChromiumSession(bytes) ?? [];
    } catch {
        return [];
    }
}

export async function loadChromiumProfiles(kind) {
    const userDataDir = chooseUserDataDir(kind);
    if (!userDataDir)
        return [];
    const names = await profileDisplayNames(userDataDir);
    const profiles = [];
    const seen = new Set();
    for (const child of listChildren(userDataDir)) {
        if (!child.directory || !sanitizeProfileDirectory(child.name))
            continue;
        const sessions = GLib.build_filenamev([userDataDir, child.name, 'Sessions']);
        const hasSession = listChildren(sessions).some(file => sessionStamp(file.name));
        if (names.has(child.name) || hasSession)
            seen.add(child.name);
    }
    for (const directory of seen) {
        profiles.push({
            directory,
            displayName: names.get(directory) || directory,
            windows: await readProfileWindows(userDataDir, directory),
        });
    }
    return profiles;
}

export async function contextFromOpenTitle(desktopId, title) {
    const kind = browserKind(desktopId, null);
    if (!kind || typeof title !== 'string' || !title.trim())
        return null;
    const assigned = assignChromiumWindows([{ id: 'open', title }], await loadChromiumProfiles(kind));
    return assigned.get('open') ?? null;
}

export async function attachChromiumContexts(records, warnings) {
    const groups = new Map();
    records.forEach((record, index) => {
        const kind = browserKind(record.app?.desktopId, record.app?.wmClass);
        if (!kind)
            return;
        const group = groups.get(kind) ?? [];
        group.push({ index, id: index, title: record.title || '' });
        groups.set(kind, group);
    });
    for (const [kind, gnomeWindows] of groups) {
        let profiles = [];
        try {
            profiles = await loadChromiumProfiles(kind);
        } catch {
            warnings?.push('Could not read browser profile information, so tabs were not saved');
            continue;
        }
        const assigned = assignChromiumWindows(gnomeWindows, profiles);
        for (const gnome of gnomeWindows) {
            const context = assigned.get(gnome.id);
            if (context)
                records[gnome.index].context = context;
        }
        if (assigned.size < gnomeWindows.length)
            warnings?.push('Some browser windows could not be matched to a profile, so those tabs were not saved');
    }
}

export function desktopExecutable(desktopId) {
    if (typeof desktopId !== 'string' || !DESKTOP_ID.test(desktopId))
        return null;
    let info = null;
    try {
        info = GioUnix.DesktopAppInfo.new(desktopId);
    } catch {
        return null;
    }
    let executable = info?.get_executable?.();
    if (typeof executable !== 'string' || !executable)
        return null;
    if (!executable.startsWith('/')) {
        if (executable.includes('/'))
            return null;
        executable = GLib.find_program_in_path(executable);
        if (typeof executable !== 'string' || !executable.startsWith('/'))
            return null;
    }
    if (executable.includes('\0') || executable.includes('\n') || executable.includes('\r'))
        return null;
    if (!GLib.file_test(executable, GLib.FileTest.IS_EXECUTABLE))
        return null;
    return executable;
}

/**
 * Build a direct browser argv. When the profile session already has the saved
 * tabs, restore that window once instead of opening the addresses again.
 * A second restore of the same profile is skipped.
 */
export function planChromiumLaunch(executable, data, claimedProfiles, options = null) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const profile = sanitizeProfileDirectory(data?.profileDirectory);
    if (!profile)
        return null;
    const urls = restorableUrls(data?.urls);
    const covered = urlsCoveredBySession(urls, options?.sessionWindows);
    if (urls.length > 0 && !covered)
        return { argv: [executable, `--profile-directory=${profile}`, '--new-window', ...urls] };
    const key = `${executable}\0${profile}`;
    if (claimedProfiles?.has(key))
        return { skip: true };
    claimedProfiles?.add(key);
    return { argv: [executable, `--profile-directory=${profile}`, '--restore-last-session'] };
}
