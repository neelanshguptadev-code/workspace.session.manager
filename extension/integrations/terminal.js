/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { readFileContents } from '../core/files.js';
import { safePath } from './vscode.js';

const MAX_TABS = 12;

export function terminalKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('ptyxis'))
        return 'ptyxis';
    return null;
}

export function terminalDirectory(uri) {
    if (typeof uri !== 'string')
        return null;
    if (uri.startsWith('file:///')) {
        try {
            return safePath(decodeURIComponent(uri.slice('file://'.length)));
        } catch {
            return null;
        }
    }
    const match = /^file:\/\/[^/]+(\/.*)$/.exec(uri);
    if (!match)
        return null;
    try {
        return safePath(decodeURIComponent(match[1]));
    } catch {
        return null;
    }
}

function normalize(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

export function assignTerminalWindows(gnomeWindows, sessions) {
    const assigned = new Map();
    const usable = (sessions ?? []).filter(session => session.directories?.length);
    if (usable.length === 1 && gnomeWindows.length === 1) {
        const context = contextFor(usable[0].directories);
        if (context)
            assigned.set(gnomeWindows[0].id, context);
        return assigned;
    }
    const used = new Set();
    gnomeWindows.forEach(gnome => {
        const title = normalize(gnome.title);
        const match = usable.findIndex((session, index) => {
            if (used.has(index))
                return false;
            const tabTitle = normalize(session.title);
            return tabTitle && (title === tabTitle || title.includes(tabTitle) || tabTitle.includes(title));
        });
        if (match < 0)
            return;
        const context = contextFor(usable[match].directories);
        if (!context)
            return;
        used.add(match);
        assigned.set(gnome.id, context);
    });
    return assigned;
}

function contextFor(directories) {
    const safe = [];
    for (const directory of directories ?? []) {
        const path = safePath(directory);
        if (!path || safe.includes(path) || safe.length >= MAX_TABS)
            continue;
        safe.push(path);
    }
    if (!safe.length)
        return null;
    return { provider: 'terminal', data: { directories: safe } };
}

function variantString(dict, key) {
    const value = dict.lookup_value(key, GLib.VariantType.new('s'));
    if (!value)
        return '';
    const [text] = value.get_string();
    return text ?? '';
}

export async function loadPtyxisSessions() {
    const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'org.gnome.Ptyxis', 'session.gvariant']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return [];
    const contents = await readFileContents(file);
    const variant = GLib.Variant.new_from_bytes(GLib.VariantType.new('a{sv}'), contents, false);
    const windows = variant.lookup_value('windows', GLib.VariantType.new('aa{sv}'));
    if (!windows)
        return [];
    const sessions = [];
    for (let index = 0; index < windows.n_children(); index += 1) {
        const window = windows.get_child_value(index);
        const tabs = window.lookup_value('tabs', GLib.VariantType.new('aa{sv}'));
        if (!tabs)
            continue;
        const directories = [];
        let title = '';
        let active = '';
        for (let tabIndex = 0; tabIndex < tabs.n_children(); tabIndex += 1) {
            const tab = tabs.get_child_value(tabIndex);
            const directory = terminalDirectory(variantString(tab, 'cwd'));
            const tabTitle = variantString(tab, 'window-title');
            const isActive = tab.lookup_value('active', GLib.VariantType.new('b'))?.get_boolean();
            if (directory)
                directories.push(directory);
            if (isActive && directory)
                active = directory;
            if (isActive && tabTitle)
                title = tabTitle;
        }
        if (active)
            directories.splice(0, directories.length, active, ...directories.filter(directory => directory !== active));
        if (directories.length)
            sessions.push({ directories, title });
    }
    return sessions;
}

export async function enrichTerminalContexts(windows) {
    const pending = [];
    windows.forEach((windowRecord, index) => {
        if (windowRecord.context || !terminalKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass))
            return;
        pending.push({ index, id: index, title: windowRecord.title });
    });
    if (!pending.length)
        return windows;
    let assigned = new Map();
    try {
        assigned = assignTerminalWindows(pending, await loadPtyxisSessions());
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

export async function attachTerminalContexts(records, warnings) {
    const enriched = await enrichTerminalContexts(records);
    let unmatched = 0;
    records.forEach((record, index) => {
        if (!terminalKind(record.app?.desktopId, record.app?.wmClass))
            return;
        if (enriched[index]?.context)
            record.context = enriched[index].context;
        else
            unmatched += 1;
    });
    if (unmatched > 0)
        warnings?.push('Some terminal windows could not be matched to a directory, so those locations were not saved');
}

export function sessionCoversDirectories(sessions, directories) {
    const available = new Set();
    for (const session of sessions ?? []) {
        for (const directory of session.directories ?? []) {
            const path = safePath(directory);
            if (path)
                available.add(path);
        }
    }
    return (directories ?? []).length > 0 && directories.every(directory => available.has(safePath(directory)));
}

export function readPtyxisRestoreEnabled() {
    try {
        return Gio.Settings.new('org.gnome.Ptyxis').get_boolean('restore-session');
    } catch {
        return false;
    }
}

/**
 * Ptyxis can reopen its own tabs when it starts. Asking for those directories
 * again opens a second copy in the same window.
 */
export function shouldDeferToPtyxisRestore(directories, { alreadyRunning = false, restoreEnabled = false, sessions = [] } = {}) {
    if (alreadyRunning || !restoreEnabled)
        return false;
    return sessionCoversDirectories(sessions, directories);
}

export function planTerminalLaunch(executable, data, options = {}) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const directories = [];
    for (const directory of data?.directories ?? []) {
        const path = safePath(directory);
        if (!path || directories.includes(path) || directories.length >= MAX_TABS)
            continue;
        directories.push(path);
    }
    if (!directories.length)
        return null;
    if (options.restoreSession) {
        if (options.alreadyClaimed)
            return { skip: true };
        return { argv: [executable], claimRestore: true };
    }
    const argv = [executable, '--new-window', `--working-directory=${directories[0]}`];
    for (const directory of directories.slice(1))
        argv.push('--tab', `--working-directory=${directory}`);
    return { argv };
}
