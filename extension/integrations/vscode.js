/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import { readFileContents } from '../core/files.js';

const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
const APP_NAMES = new Set([
    'visual studio code',
    'visual studio code - insiders',
    'code - oss',
    'vscodium',
    'cursor',
    'code',
]);
const SAFE_DESKTOP_FLAGS = new Set(['--force-user-env']);
const USER_DATA = {
    code: [
        ['.config', 'Code'],
        ['snap', 'code', 'current', '.config', 'Code'],
    ],
    insiders: [
        ['.config', 'Code - Insiders'],
    ],
    codium: [
        ['.config', 'VSCodium'],
        ['.config', 'Code - OSS'],
    ],
    cursor: [
        ['.config', 'Cursor'],
    ],
};

export function codeKind(desktopId, wmClass) {
    const id = `${desktopId ?? ''} ${wmClass ?? ''}`.toLowerCase();
    if (id.includes('cursor'))
        return 'cursor';
    if (id.includes('insiders'))
        return 'insiders';
    if (id.includes('codium') || id.includes('code-oss') || id.includes('code - oss'))
        return 'codium';
    if (/(^|[\s._-])code([\s._-]|$)/.test(id) || id.includes('code_code'))
        return 'code';
    return null;
}

export function parseCodeRoot(title) {
    let text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
    text = text.replace(/^[●•*]+\s*/, '');
    if (!text || /\[(SSH|WSL|Dev Container|Tunnel):/i.test(text))
        return '';
    const parts = (text.includes(' — ') ? text.split(' — ') : text.split(' - '))
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length > 0 && APP_NAMES.has(parts[parts.length - 1].toLowerCase()))
        parts.pop();
    return parts.length > 0 ? parts[parts.length - 1] : '';
}

export function fileUriToPath(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file:///'))
        return null;
    let path = uri.slice('file://'.length);
    try {
        path = decodeURIComponent(path);
    } catch {
        return null;
    }
    return safePath(path);
}

export function safePath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096)
        return null;
    if (/[\u0000-\u001f]/.test(path))
        return null;
    if (path.split('/').some(part => part === '..'))
        return null;
    return path;
}

function basename(path) {
    const name = path.split('/').filter(Boolean).pop() ?? '';
    return name.replace(/\.code-workspace$/i, '');
}

function projectFromUri(folderUri, workspaceUri, frame) {
    const folder = safePath(folderUri) ?? fileUriToPath(folderUri);
    const workspaceFile = safePath(workspaceUri) ?? fileUriToPath(workspaceUri);
    const target = workspaceFile ?? folder;
    if (!target)
        return null;
    if (workspaceFile && !workspaceFile.toLowerCase().endsWith('.code-workspace'))
        return null;
    return {
        folder: workspaceFile ? null : folder,
        workspaceFile: workspaceFile ?? null,
        basename: basename(target).toLowerCase(),
        frame: frame ?? null,
    };
}

function frameFromUiState(uiState) {
    if (!uiState || typeof uiState !== 'object')
        return null;
    const { x, y, width, height } = uiState;
    if (![x, y, width, height].every(value => Number.isInteger(value)))
        return null;
    if (width < 1 || height < 1)
        return null;
    return { x, y, width, height };
}

function projectFromState(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    const frame = frameFromUiState(entry.uiState);
    const workspace = entry.workspaceIdentifier?.configURIPath ?? entry.workspace?.configURIPath;
    return projectFromUri(entry.folder, workspace, frame);
}

function framesClose(saved, live) {
    if (!saved || !live)
        return false;
    return Math.abs(saved.x - live.x) <= 48 &&
        Math.abs(saved.y - live.y) <= 48 &&
        Math.abs(saved.width - live.width) <= 80 &&
        Math.abs(saved.height - live.height) <= 80;
}

function contextFor(project) {
    if (project.workspaceFile)
        return { provider: 'vscode', data: { workspaceFile: project.workspaceFile } };
    if (project.folder)
        return { provider: 'vscode', data: { folder: project.folder } };
    return null;
}

/**
 * Pair editor windows with project folders. gnomeWindows are { id, title, frame }.
 * projects are { folder, workspaceFile, basename, frame }.
 */
export function assignCodeWindows(gnomeWindows, projects) {
    const assigned = new Map();
    const usable = (projects ?? []).filter(project => project?.basename && contextFor(project));
    const pairs = [];
    gnomeWindows.forEach((gnome, gnomeIndex) => {
        const root = parseCodeRoot(gnome.title).toLowerCase();
        if (!root)
            return;
        usable.forEach((project, projectIndex) => {
            if (project.basename !== root)
                return;
            let score = 80;
            if (framesClose(project.frame, gnome.frame))
                score += 30;
            if (project.preferred)
                score += 15;
            pairs.push({ gnomeIndex, projectIndex, score });
        });
    });
    pairs.sort((left, right) => right.score - left.score || left.projectIndex - right.projectIndex);
    const usedGnome = new Set();
    const usedProject = new Set();
    for (const pair of pairs) {
        if (usedGnome.has(pair.gnomeIndex) || usedProject.has(pair.projectIndex))
            continue;
        const rival = pairs.find(other => {
            return other.gnomeIndex === pair.gnomeIndex &&
                other.projectIndex !== pair.projectIndex &&
                !usedProject.has(other.projectIndex) &&
                pair.score - other.score < 10;
        });
        if (rival) {
            usedGnome.add(pair.gnomeIndex);
            continue;
        }
        const context = contextFor(usable[pair.projectIndex]);
        if (!context)
            continue;
        usedGnome.add(pair.gnomeIndex);
        usedProject.add(pair.projectIndex);
        assigned.set(gnomeWindows[pair.gnomeIndex].id, context);
    }
    return assigned;
}

function homePath(parts) {
    return GLib.build_filenamev([GLib.get_home_dir(), ...parts]);
}

async function readJson(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() <= 0 || info.get_size() > MAX_STORAGE_BYTES)
        return null;
    const contents = await readFileContents(file);
    const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
    return JSON.parse(new TextDecoder().decode(bytes));
}

function dedupeProjects(projects) {
    const seen = new Set();
    const unique = [];
    for (const project of projects) {
        if (!project)
            continue;
        const key = project.workspaceFile ?? project.folder;
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        unique.push(project);
    }
    return unique;
}

async function recentProjects(userDataDir) {
    const root = GLib.build_filenamev([userDataDir, 'User', 'workspaceStorage']);
    const directory = Gio.File.new_for_path(root);
    if (!directory.query_exists(null))
        return [];
    const found = [];
    const enumerator = directory.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    try {
        while (found.length < 500) {
            const info = enumerator.next_file(null);
            if (!info)
                break;
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const entry = GLib.build_filenamev([root, info.get_name()]);
            try {
                const workspace = await readJson(GLib.build_filenamev([entry, 'workspace.json']));
                const project = projectFromUri(workspace?.folder, workspace?.workspace, null);
                if (!project)
                    continue;
                const used = Gio.File.new_for_path(entry)
                    .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
                    .get_modification_date_time()?.to_unix() ?? 0;
                found.push({ ...project, recent: used });
            } catch {
                // One unreadable entry does not hide the rest.
            }
        }
    } finally {
        enumerator.close(null);
    }
    return found;
}

function rankDuplicateNames(projects) {
    const newest = new Map();
    for (const project of projects) {
        const current = newest.get(project.basename);
        if (!current || (project.recent ?? 0) > (current.recent ?? 0))
            newest.set(project.basename, project);
    }
    return projects.map(project => ({
        ...project,
        preferred: project.open || newest.get(project.basename) === project,
    }));
}

export async function loadCodeProjects(kind) {
    const userDataDir = (USER_DATA[kind] ?? [])
        .map(parts => homePath(parts))
        .find(path => Gio.File.new_for_path(GLib.build_filenamev([path, 'User'])).query_exists(null));
    if (!userDataDir)
        return [];
    const projects = [];
    let storage = null;
    try {
        storage = await readJson(GLib.build_filenamev([userDataDir, 'User', 'globalStorage', 'storage.json']));
    } catch {
        storage = null;
    }
    const state = storage?.windowsState ?? {};
    const backup = storage?.backupWorkspaces ?? {};
    const open = project => (project ? { ...project, open: true } : null);
    for (const entry of state.openedWindows ?? [])
        projects.push(open(projectFromState(entry)));
    projects.push(open(projectFromState(state.lastActiveWindow)));
    for (const entry of backup.folders ?? [])
        projects.push(open(projectFromUri(entry?.folderUri, null, null)));
    for (const entry of backup.workspaces ?? []) {
        const workspace = entry?.workspace?.configURIPath ?? entry?.configURIPath;
        projects.push(open(projectFromUri(null, workspace, null)));
    }
    try {
        projects.push(...await recentProjects(userDataDir));
    } catch {
        // Recent projects are optional.
    }
    return rankDuplicateNames(dedupeProjects(projects));
}

export async function contextFromCodeWindow(desktopId, wmClass, title, frame) {
    const kind = codeKind(desktopId, wmClass);
    if (!kind || !parseCodeRoot(title))
        return null;
    const assigned = assignCodeWindows([{ id: 'open', title, frame }], await loadCodeProjects(kind));
    return assigned.get('open') ?? null;
}

export async function enrichCodeContexts(windows) {
    const groups = new Map();
    windows.forEach((windowRecord, index) => {
        const kind = codeKind(windowRecord.app?.desktopId, windowRecord.app?.wmClass);
        if (windowRecord.context || !kind)
            return;
        const group = groups.get(kind) ?? [];
        group.push({ index, id: index, title: windowRecord.title, frame: windowRecord.frame });
        groups.set(kind, group);
    });
    if (groups.size === 0)
        return windows;
    const assigned = new Map();
    for (const [kind, pending] of groups) {
        try {
            for (const [id, context] of assignCodeWindows(pending, await loadCodeProjects(kind)))
                assigned.set(id, context);
        } catch {
            // One editor's unreadable state does not block another editor.
        }
    }
    if (assigned.size === 0)
        return windows;
    return windows.map((windowRecord, index) => {
        const context = assigned.get(index);
        return context ? { ...windowRecord, context } : windowRecord;
    });
}

export async function attachCodeContexts(records, warnings) {
    const enriched = await enrichCodeContexts(records);
    let unmatched = 0;
    records.forEach((record, index) => {
        if (!codeKind(record.app?.desktopId, record.app?.wmClass))
            return;
        if (enriched[index]?.context)
            record.context = enriched[index].context;
        else
            unmatched += 1;
    });
    if (unmatched > 0)
        warnings?.push('Some editor windows could not be matched to a project folder, so those folders were not saved');
}

function splitCommandLine(command) {
    const parts = [];
    let current = '';
    let quote = '';
    for (const character of command) {
        if (quote) {
            if (character === quote)
                quote = '';
            else
                current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === ' ' || character === '\t') {
            if (current) {
                parts.push(current);
                current = '';
            }
            continue;
        }
        current += character;
    }
    if (current)
        parts.push(current);
    return parts;
}

export function desktopSafeFlags(desktopId) {
    if (typeof desktopId !== 'string')
        return [];
    let info = null;
    try {
        info = GioUnix.DesktopAppInfo.new(desktopId);
    } catch {
        return [];
    }
    const command = info?.get_commandline?.() ?? '';
    return splitCommandLine(command).filter(part => SAFE_DESKTOP_FLAGS.has(part));
}

export function codeTitleMatches(title, data) {
    const target = data?.workspaceFile ?? data?.folder;
    if (typeof target !== 'string')
        return false;
    const root = parseCodeRoot(title).toLowerCase();
    return Boolean(root) && root === basename(target).toLowerCase();
}

/**
 * Open one project in a new editor window. The path is a single argument.
 */
export function planCodeLaunch(executable, desktopFlags, data) {
    if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0'))
        return null;
    const folder = safePath(data?.folder);
    const workspaceFile = safePath(data?.workspaceFile);
    const target = workspaceFile ?? folder;
    if (!target)
        return null;
    if (workspaceFile && !workspaceFile.toLowerCase().endsWith('.code-workspace'))
        return null;
    const flags = (desktopFlags ?? []).filter(flag => SAFE_DESKTOP_FLAGS.has(flag));
    return { argv: [executable, ...flags, '--new-window', target] };
}
