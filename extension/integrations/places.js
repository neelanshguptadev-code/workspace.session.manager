/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import { readFileContents } from '../core/files.js';
import { safePath } from './vscode.js';

const SPECIAL_DIRECTORIES = [
    GLib.UserDirectory.DIRECTORY_DESKTOP,
    GLib.UserDirectory.DIRECTORY_DOCUMENTS,
    GLib.UserDirectory.DIRECTORY_DOWNLOAD,
    GLib.UserDirectory.DIRECTORY_MUSIC,
    GLib.UserDirectory.DIRECTORY_PICTURES,
    GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE,
    GLib.UserDirectory.DIRECTORY_TEMPLATES,
    GLib.UserDirectory.DIRECTORY_VIDEOS,
];

export function fileManagerKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('nautilus'))
        return 'nautilus';
    if (id.includes('nemo'))
        return 'nemo';
    if (id.includes('thunar'))
        return 'thunar';
    if (id.includes('dolphin'))
        return 'dolphin';
    return null;
}

const MAX_RECENT_BYTES = 8 * 1024 * 1024;

function normalizeName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

function fileIdentity(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'id::file,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            return null;
        return info.get_attribute_string('id::file') || path;
    } catch {
        return null;
    }
}

function decodeFileUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file:///'))
        return null;
    try {
        return safePath(decodeURIComponent(uri.slice('file://'.length)));
    } catch {
        return null;
    }
}

async function readText(path, limit) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return '';
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() <= 0 || info.get_size() > limit)
        return '';
    const contents = await readFileContents(file);
    return new TextDecoder().decode(contents instanceof Uint8Array ? contents : new Uint8Array(contents));
}

async function bookmarkPlaces() {
    const places = [];
    const text = await readText(GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'bookmarks']), 256 * 1024);
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const space = trimmed.indexOf(' ');
        const uri = space < 0 ? trimmed : trimmed.slice(0, space);
        const label = space < 0 ? '' : trimmed.slice(space + 1).trim();
        const path = decodeFileUri(uri);
        if (!path)
            continue;
        places.push({ name: GLib.path_get_basename(path), path });
        if (label)
            places.push({ name: label, path });
    }
    return places;
}

async function recentPlaces() {
    const text = await readText(GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']), MAX_RECENT_BYTES);
    const places = [];
    const seen = new Set();
    const pattern = /href="(file:\/\/\/[^"]+)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null && seen.size < 4000) {
        const path = decodeFileUri(match[1].replace(/&amp;/g, '&'));
        if (!path)
            continue;
        const parts = path.split('/');
        for (let index = 2; index < parts.length; index += 1) {
            const directory = parts.slice(0, index).join('/');
            if (seen.has(directory))
                continue;
            seen.add(directory);
            places.push({ name: parts[index - 1], path: directory });
        }
    }
    return places;
}

/**
 * Pick one directory for each visible folder name. Earlier tiers win; a name that
 * points at two different folders in the same tier is left unresolved.
 */
export function resolvePlaces(tiers, identify = fileIdentity) {
    const places = [];
    const decided = new Set();
    for (const tier of tiers) {
        const byName = new Map();
        for (const place of tier) {
            const key = normalizeName(place.name);
            const path = safePath(place.path);
            if (!key || !path || decided.has(key))
                continue;
            const identity = identify(path);
            if (!identity)
                continue;
            const entry = byName.get(key) ?? { name: place.name, path, identities: new Set() };
            entry.identities.add(identity);
            byName.set(key, entry);
        }
        for (const [key, entry] of byName) {
            decided.add(key);
            if (entry.identities.size === 1)
                places.push({ name: entry.name, path: entry.path });
        }
    }
    return places;
}

function childDirectories(path) {
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
        while (names.length < 300) {
            const info = enumerator.next_file(null);
            if (!info)
                break;
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const name = info.get_name();
            if (!name || name.startsWith('.'))
                continue;
            names.push(name);
        }
    } finally {
        enumerator.close(null);
    }
    return names;
}

export async function loadPlaces() {
    const home = GLib.get_home_dir();
    const standard = [{ name: 'Home', path: home }];
    const roots = [home];
    for (const kind of SPECIAL_DIRECTORIES) {
        let path = null;
        try {
            path = GLib.get_user_special_dir(kind);
        } catch {
            path = null;
        }
        if (!path)
            continue;
        standard.push({ name: GLib.path_get_basename(path), path });
        roots.push(path);
    }
    const children = [];
    for (const root of roots) {
        let names = [];
        try {
            names = childDirectories(root);
        } catch {
            names = [];
        }
        for (const name of names)
            children.push({ name, path: GLib.build_filenamev([root, name]) });
    }
    let bookmarks = [];
    let recent = [];
    try {
        bookmarks = await bookmarkPlaces();
    } catch {
        bookmarks = [];
    }
    try {
        recent = await recentPlaces();
    } catch {
        recent = [];
    }
    return resolvePlaces([standard, bookmarks, children, recent]);
}

export function directoryTitleMatches(title, data) {
    const path = safePath(data?.path);
    if (!path)
        return false;
    const text = normalizeName(title);
    if (path === GLib.get_home_dir() && text === 'home')
        return true;
    return text === normalizeName(GLib.path_get_basename(path));
}

export function directoryForTitle(title, places) {
    const text = normalizeName(title);
    if (!text)
        return null;
    if (text === 'home')
        return places.find(place => place.name === 'Home')?.path ?? null;
    const matches = places.filter(place => normalizeName(place.name) === text);
    return matches.length === 1 ? matches[0].path : null;
}

function contextFor(path) {
    const safe = safePath(path);
    if (!safe)
        return null;
    return { provider: 'directory', data: { path: safe } };
}

export async function enrichDirectoryContexts(windows) {
    const pending = windows.some(windowRecord => {
        return !windowRecord.context && fileManagerKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass);
    });
    if (!pending)
        return windows;
    let places = [];
    try {
        places = await loadPlaces();
    } catch {
        return windows;
    }
    return windows.map(windowRecord => {
        if (windowRecord.context || !fileManagerKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass))
            return windowRecord;
        const context = contextFor(directoryForTitle(windowRecord.title, places));
        return context ? { ...windowRecord, context } : windowRecord;
    });
}

export async function attachDirectoryContexts(records, warnings) {
    const enriched = await enrichDirectoryContexts(records);
    let unmatched = 0;
    records.forEach((record, index) => {
        if (!fileManagerKind(record.app?.desktopId, record.app?.wmClass))
            return;
        if (enriched[index]?.context)
            record.context = enriched[index].context;
        else
            unmatched += 1;
    });
    if (unmatched > 0)
        warnings?.push('Some file windows could not be matched to a folder, so those locations were not saved');
}

export function desktopUsesNewWindow(desktopId) {
    if (typeof desktopId !== 'string')
        return false;
    try {
        const command = GioUnix.DesktopAppInfo.new(desktopId)?.get_commandline?.() ?? '';
        return command.includes('--new-window');
    } catch {
        return false;
    }
}

export function planDirectoryLaunch(executable, desktopFlags, data) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const path = safePath(data?.path);
    if (!path)
        return null;
    const argv = [executable];
    if ((desktopFlags ?? []).includes('--new-window'))
        argv.push('--new-window');
    argv.push(path);
    return { argv };
}
