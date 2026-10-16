/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import { readFileContents } from '../core/files.js';
import { safePath } from './vscode.js';

const MAX_RECENT_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 4000;
const DOCUMENT_FLAGS = ['--new-window', '--norestore', '--writer', '--calc', '--impress', '--draw'];
const APP_SUFFIX = /\s+[—–-]\s+(?:text editor|gedit|document viewer|papers|evince|libreoffice(?:\s+[a-z0-9.]+)?)$/i;

export function documentKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('gnome-text-editor') || id.includes('org.gnome.texteditor'))
        return 'text-editor';
    if (/(^|[^a-z])gedit([^a-z]|$)/.test(id))
        return 'gedit';
    if (id.includes('papers') || id.includes('evince'))
        return 'papers';
    if (id.includes('libreoffice-writer') || id.includes('libreoffice-calc') ||
        id.includes('libreoffice-impress') || id.includes('libreoffice-draw'))
        return 'libreoffice';
    return null;
}

function unescapeXml(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
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

function basename(path) {
    return path.split('/').filter(Boolean).pop() ?? '';
}

function fileStem(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

function cleanName(value) {
    return value.replace(/^[●•*]+\s*/, '').replace(/\s*\*+$/, '').trim();
}

/**
 * The visible document name, without the application suffix.
 * A gedit-style "name (/directory)" title also returns that directory.
 */
export function documentStem(title) {
    let text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    text = text.replace(/\s+\((?:modified|unsaved|read-only|read only)\)$/i, '');
    if (!text)
        return { name: '', directory: null };
    const withDirectory = text.match(/^(.*?)\s+\((\/[^)]*)\)(?:\s+[—–-]\s+.*)?$/);
    if (withDirectory)
        return { name: cleanName(withDirectory[1]), directory: withDirectory[2] };
    return { name: cleanName(text.replace(APP_SUFFIX, '')), directory: null };
}

export function parseRecentDocuments(xml) {
    const documents = [];
    const pattern = /<bookmark\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/bookmark>/g;
    let match;
    while ((match = pattern.exec(xml)) !== null && documents.length < MAX_DOCUMENTS) {
        if (/<mime:mime-type type="inode\/directory"/.test(match[2]))
            continue;
        const path = decodeFileUri(unescapeXml(match[1]));
        if (!path)
            continue;
        documents.push({ path, name: basename(path) });
    }
    return documents;
}

async function readRecentXml() {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return '';
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() <= 0 || info.get_size() > MAX_RECENT_BYTES)
        return '';
    const contents = await readFileContents(file);
    return new TextDecoder().decode(contents instanceof Uint8Array ? contents : new Uint8Array(contents));
}

export async function loadRecentDocuments() {
    try {
        return parseRecentDocuments(await readRecentXml());
    } catch {
        return [];
    }
}

export function documentForTitle(title, documents) {
    const stem = documentStem(title);
    if (!stem.name || stem.name.includes('/') || stem.name === '.' || stem.name === '..')
        return null;
    if (stem.directory) {
        const directory = stem.directory.replace(/\/+$/, '');
        return safePath(`${directory}/${stem.name}`);
    }
    const wanted = stem.name.toLowerCase();
    const matches = [];
    const seen = new Set();
    for (const document of documents ?? []) {
        const path = safePath(document.path);
        if (!path || seen.has(path))
            continue;
        const name = basename(path).toLowerCase();
        const exact = name === wanted;
        const withoutExtension = fileStem(basename(path)).toLowerCase() === wanted;
        if (wanted.includes('.') ? !exact : !exact && !withoutExtension)
            continue;
        seen.add(path);
        matches.push(path);
    }
    return matches.length === 1 ? matches[0] : null;
}

export function documentTitleMatches(title, data) {
    const path = safePath(data?.path);
    if (!path)
        return false;
    const name = documentStem(title).name.toLowerCase();
    const base = basename(path).toLowerCase();
    return name === base || name === fileStem(basename(path)).toLowerCase();
}

export function flagsForDocument(kind, commandLine) {
    const found = [];
    for (const part of String(commandLine ?? '').split(/\s+/)) {
        if (DOCUMENT_FLAGS.includes(part) && !found.includes(part))
            found.push(part);
    }
    if (kind === 'text-editor' && !found.includes('--new-window'))
        found.unshift('--new-window');
    if (kind === 'libreoffice' && !found.includes('--norestore'))
        found.push('--norestore');
    return found;
}

export function documentCommandLine(desktopId) {
    if (typeof desktopId !== 'string')
        return '';
    try {
        return GioUnix.DesktopAppInfo.new(desktopId)?.get_commandline?.() ?? '';
    } catch {
        return '';
    }
}

export function planDocumentLaunch(executable, flags, data) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const path = safePath(data?.path);
    if (!path)
        return null;
    const argv = [executable];
    for (const flag of flags ?? []) {
        if (DOCUMENT_FLAGS.includes(flag))
            argv.push(flag);
    }
    argv.push(path);
    return { argv };
}

function contextFor(path) {
    const safe = safePath(path);
    return safe ? { provider: 'document', data: { path: safe } } : null;
}

export async function enrichDocumentContexts(windows, documents = null) {
    const pending = (windows ?? []).some(windowRecord => {
        return !windowRecord.context && documentKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass);
    });
    if (!pending)
        return windows ?? [];
    const recent = documents ?? await loadRecentDocuments();
    return windows.map(windowRecord => {
        if (windowRecord.context || !documentKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass))
            return windowRecord;
        const context = contextFor(documentForTitle(windowRecord.title, recent));
        return context ? { ...windowRecord, context } : windowRecord;
    });
}

export async function attachDocumentContexts(records, warnings) {
    const enriched = await enrichDocumentContexts(records);
    let unmatched = 0;
    records.forEach((record, index) => {
        if (!documentKind(record.app?.desktopId, record.app?.wmClass))
            return;
        if (enriched[index]?.context)
            record.context = enriched[index].context;
        else
            unmatched += 1;
    });
    if (unmatched > 0)
        warnings?.push('Some document windows could not be matched to a file, so those documents were not saved');
}
