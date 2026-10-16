/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readFileContents } from './files.js';
import { normalizeRecovery, RECOVERY_FORMAT, RECOVERY_VERSION } from './recovery.js';
import { MAX_SESSION_BYTES, validateSession } from './model.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultSessionsDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'workspace-sessions',
        'sessions',
    ]);
}

export function defaultUndoDirectory() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'workspace-sessions',
        'undo',
    ]);
}

export function defaultRecoveryFile() {
    return GLib.build_filenamev([
        GLib.get_user_data_dir(),
        'workspace-sessions',
        'recovery.json',
    ]);
}

function ensureDirectory(directory) {
    if (GLib.mkdir_with_parents(directory, 0o700) !== 0)
        throw new Error(`Could not create ${directory}`);
}

function sessionPath(directory, id) {
    if (typeof id !== 'string' || !UUID.test(id))
        throw new Error('Session id is not a UUID');
    return GLib.build_filenamev([directory, `${id}.json`]);
}

function encode(session) {
    return new TextEncoder().encode(`${JSON.stringify(session, null, 2)}\n`);
}

function decode(contents) {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents);
}

function writeBytesAtomic(destinationPath, contents) {
    ensureDirectory(GLib.path_get_dirname(destinationPath));
    const temporaryPath = `${destinationPath}.${GLib.get_monotonic_time()}.tmp`;
    const temporary = Gio.File.new_for_path(temporaryPath);
    const destination = Gio.File.new_for_path(destinationPath);
    try {
        temporary.replace_contents(
            contents,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
        GLib.chmod(temporaryPath, 0o600);
        temporary.move(destination, Gio.FileCopyFlags.OVERWRITE, null, null);
        GLib.chmod(destinationPath, 0o600);
    } catch (error) {
        try {
            temporary.delete(null);
        } catch {
            // The temporary file may already have been moved.
        }
        throw error;
    }
    return destinationPath;
}

export function writeSession(session, directory = defaultSessionsDirectory()) {
    const result = validateSession(session);
    if (!result.ok)
        throw new Error(result.errors.join('\n'));
    return writeBytesAtomic(sessionPath(directory, result.session.id), encode(result.session));
}

export async function readSession(id, directory = defaultSessionsDirectory()) {
    const path = sessionPath(directory, id);
    return readSessionFile(path, id);
}

export async function readSessionFile(path, expectedId = null) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_size() > MAX_SESSION_BYTES)
        throw new Error('Session file is too large');
    const contents = await readFileContents(file);
    if (contents.length > MAX_SESSION_BYTES)
        throw new Error('Session file is too large');
    let parsed;
    try {
        parsed = JSON.parse(decode(contents));
    } catch {
        throw new Error(`Session file is not valid JSON: ${GLib.path_get_basename(path)}`);
    }
    const result = validateSession(parsed);
    if (!result.ok)
        throw new Error(result.errors.join('\n'));
    if (expectedId !== null && result.session.id !== expectedId)
        throw new Error('Session id does not match the file name');
    const base = GLib.path_get_basename(path);
    if (base !== `${result.session.id}.json`)
        throw new Error('Session file name does not match its id');
    return result.session;
}

export async function listSessions(directory = defaultSessionsDirectory()) {
    const sessions = [];
    const errors = [];
    const directoryFile = Gio.File.new_for_path(directory);
    if (!directoryFile.query_exists(null))
        return { sessions, errors };

    const enumerator = directoryFile.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
    );
    let info = enumerator.next_file(null);
    while (info) {
        const name = info.get_name();
        if (name.endsWith('.json') && !name.endsWith('.tmp')) {
            const child = directoryFile.get_child(name);
            try {
                sessions.push(await readSessionFile(child.get_path()));
            } catch (error) {
                errors.push(`${name}: ${error.message}`);
            }
        }
        info = enumerator.next_file(null);
    }
    enumerator.close(null);
    sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { sessions, errors };
}

export function deleteSession(id, directory = defaultSessionsDirectory()) {
    const file = Gio.File.new_for_path(sessionPath(directory, id));
    file.delete(null);
}

export function writeRecovery(record, path = defaultRecoveryFile()) {
    const normalized = normalizeRecovery({
        format: RECOVERY_FORMAT,
        formatVersion: RECOVERY_VERSION,
        clean: record.clean,
        savedAt: record.savedAt,
        captured: record.captured,
    });
    if (!normalized)
        throw new Error('Recovery snapshot is not valid');
    return writeBytesAtomic(path, encode({
        format: RECOVERY_FORMAT,
        formatVersion: RECOVERY_VERSION,
        clean: normalized.clean,
        savedAt: normalized.savedAt,
        captured: normalized.captured,
    }));
}

export async function readRecovery(path = defaultRecoveryFile()) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    try {
        const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_size() > MAX_SESSION_BYTES)
            return null;
        const contents = await readFileContents(file);
        if (contents.length > MAX_SESSION_BYTES)
            return null;
        return normalizeRecovery(JSON.parse(decode(contents)));
    } catch {
        return null;
    }
}
