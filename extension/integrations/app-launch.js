/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

import {
    browserKind,
    contextFromOpenTitle,
    desktopExecutable,
    loadChromiumProfiles,
    planChromiumLaunch,
} from './chromium.js';
import {
    documentCommandLine,
    documentForTitle,
    documentKind,
    documentTitleMatches,
    flagsForDocument,
    loadRecentDocuments,
    planDocumentLaunch,
} from './documents.js';
import { planFirefoxLaunch } from './firefox.js';
import {
    desktopUsesNewWindow,
    directoryForTitle,
    directoryTitleMatches,
    fileManagerKind,
    loadPlaces,
    planDirectoryLaunch,
} from './places.js';
import {
    loadPtyxisSessions,
    planTerminalLaunch,
    readPtyxisRestoreEnabled,
    shouldDeferToPtyxisRestore,
    terminalKind,
} from './terminal.js';
import { codeTitleMatches, contextFromCodeWindow, desktopSafeFlags, planCodeLaunch } from './vscode.js';

async function chromiumContextFor(action) {
    if (action.context?.provider === 'chromium')
        return action.context;
    if (!action.title)
        return null;
    try {
        return await contextFromOpenTitle(action.desktopId, action.title);
    } catch {
        return null;
    }
}

async function sessionWindowsFor(desktopId, profileDirectory) {
    const kind = browserKind(desktopId, null);
    if (!kind || !profileDirectory)
        return null;
    const profile = (await loadChromiumProfiles(kind)).find(item => item.directory === profileDirectory);
    return profile ? profile.windows : null;
}

async function codeContextFor(action) {
    if (action.context?.provider === 'vscode')
        return action.context;
    if (!action.title)
        return null;
    return contextFromCodeWindow(action.desktopId, null, action.title, action.frame);
}

function codeTargetExists(data) {
    if (typeof data?.folder === 'string')
        return GLib.file_test(data.folder, GLib.FileTest.IS_DIR);
    if (typeof data?.workspaceFile === 'string')
        return GLib.file_test(data.workspaceFile, GLib.FileTest.IS_REGULAR);
    return false;
}

async function documentContextFor(action) {
    if (action.context?.provider === 'document')
        return action.context;
    if (!action.title || !documentKind(action.desktopId, null))
        return null;
    const path = documentForTitle(action.title, await loadRecentDocuments());
    return path ? { provider: 'document', data: { path } } : null;
}

async function directoryContextFor(action) {
    if (action.context?.provider === 'directory')
        return action.context;
    if (!action.title || !fileManagerKind(action.desktopId, null))
        return null;
    const path = directoryForTitle(action.title, await loadPlaces());
    return path ? { provider: 'directory', data: { path } } : null;
}

/**
 * Choose an argv for an application that publishes its window contents.
 * Returns null when the window should use a normal application launch.
 */
export async function planAppLaunch(action, job, options = {}) {
    try {
        const chromiumContext = await chromiumContextFor(action);
        if (chromiumContext) {
            const plan = planChromiumLaunch(
                desktopExecutable(action.desktopId),
                chromiumContext.data,
                job?.chromiumProfiles,
                { sessionWindows: await sessionWindowsFor(action.desktopId, chromiumContext.data?.profileDirectory) },
            );
            if (plan?.skip)
                return { skip: true };
            if (!plan?.argv)
                return { failed: true };
            return { argv: plan.argv, slow: true };
        }

        const codeContext = await codeContextFor(action);
        if (codeContext) {
            const plan = planCodeLaunch(
                desktopExecutable(action.desktopId),
                desktopSafeFlags(action.desktopId),
                codeContext.data,
            );
            if (!plan?.argv || !codeTargetExists(codeContext.data))
                return { failed: true };
            return {
                argv: plan.argv,
                slow: true,
                matchesTitle: title => codeTitleMatches(title, codeContext.data),
            };
        }

        const directoryContext = await directoryContextFor(action);
        if (directoryContext) {
            const flags = desktopUsesNewWindow(action.desktopId) ? ['--new-window'] : [];
            const plan = planDirectoryLaunch(desktopExecutable(action.desktopId), flags, directoryContext.data);
            if (!plan?.argv || !GLib.file_test(directoryContext.data.path, GLib.FileTest.IS_DIR))
                return { failed: true };
            return {
                argv: plan.argv,
                matchesTitle: title => directoryTitleMatches(title, directoryContext.data),
            };
        }

        const documentContext = await documentContextFor(action);
        if (documentContext) {
            const kind = documentKind(action.desktopId, null);
            const plan = planDocumentLaunch(
                desktopExecutable(action.desktopId),
                flagsForDocument(kind, documentCommandLine(action.desktopId)),
                documentContext.data,
            );
            if (!plan?.argv || !GLib.file_test(documentContext.data.path, GLib.FileTest.IS_REGULAR))
                return { failed: true };
            return {
                argv: plan.argv,
                slow: kind === 'libreoffice',
                matchesTitle: title => documentTitleMatches(title, documentContext.data),
            };
        }

        if (action.context?.provider === 'terminal' && terminalKind(action.desktopId, null)) {
            const requested = [];
            for (const directory of action.context.data?.directories ?? []) {
                if (typeof directory === 'string')
                    requested.push(directory);
            }
            let sessions = [];
            try {
                sessions = await loadPtyxisSessions();
            } catch {
                sessions = [];
            }
            const plan = planTerminalLaunch(desktopExecutable(action.desktopId), action.context.data, {
                restoreSession: shouldDeferToPtyxisRestore(requested, {
                    alreadyRunning: options.alreadyRunning === true,
                    restoreEnabled: readPtyxisRestoreEnabled(),
                    sessions,
                }),
                alreadyClaimed: job?.ptyxisRestored === true,
            });
            if (plan?.skip)
                return { skip: true };
            const directories = plan?.argv?.filter(arg => arg.startsWith('--working-directory=')) ?? [];
            const exists = directories.every(arg => GLib.file_test(arg.slice('--working-directory='.length), GLib.FileTest.IS_DIR));
            if (!plan?.argv || !exists)
                return { failed: true };
            if (plan.claimRestore && job)
                job.ptyxisRestored = true;
            return { argv: plan.argv, claimRestore: plan.claimRestore === true };
        }

        if (action.context?.provider === 'firefox') {
            const plan = planFirefoxLaunch(desktopExecutable(action.desktopId), action.context.data);
            if (!plan?.argv)
                return { failed: true };
            return { argv: plan.argv, slow: true };
        }
    } catch {
        return null;
    }
    return null;
}
