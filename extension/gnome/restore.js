/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

import { planMerge, progressText, summarizePlan } from '../core/matching.js';
import { enrichDocumentContexts } from '../integrations/documents.js';
import { enrichFirefoxContexts } from '../integrations/firefox.js';
import { enrichDirectoryContexts } from '../integrations/places.js';
import { enrichTerminalContexts } from '../integrations/terminal.js';
import { enrichCodeContexts } from '../integrations/vscode.js';
import { inspectDesktop } from './inspector.js';
import { launchAndPlace } from './launch.js';
import { activateWorkspaceAndWindow, applyWindowPlacement } from './placement.js';

const SETTLE_DELAY_MS = 2500;

async function enrichSessionWindows(windows) {
    let current = windows ?? [];
    current = await enrichCodeContexts(current);
    current = await enrichDirectoryContexts(current);
    current = await enrichTerminalContexts(current);
    current = await enrichFirefoxContexts(current);
    return enrichDocumentContexts(current);
}

export async function previewMerge(session, source) {
    const inspected = await inspectDesktop(source);
    const liveRecords = inspected.liveWindows.map(entry => entry.record);
    const windows = await enrichSessionWindows(session.windows);
    const plan = planMerge(
        { ...session, windows },
        liveRecords,
        inspected.captured.monitors,
        inspected.captured.environment,
    );
    return {
        plan,
        windows,
        summary: summarizePlan(plan),
        liveWindows: inspected.liveWindows,
        captured: inspected.captured,
    };
}

export function createRestoreJob() {
    let cancelled = false;
    const connections = [];
    return {
        cancel() {
            cancelled = true;
            this._runCleanups();
        },
        get cancelled() {
            return cancelled;
        },
        isCancelled() {
            return cancelled;
        },
        chromiumProfiles: new Set(),
        addCleanup(fn) {
            connections.push(fn);
        },
        _runCleanups() {
            const pending = connections.splice(0);
            for (const fn of pending) {
                try {
                    fn();
                } catch {
                    // Ignore cleanup failures while disabling.
                }
            }
        },
        destroy() {
            cancelled = true;
            this._runCleanups();
        },
    };
}

/**
 * Merge-restore the session. Matching windows are moved. Missing applications
 * are launched. Nothing is closed.
 */
export async function mergeRestore(session, source, job, options = {}) {
    const onProgress = options.onProgress;
    const preview = await previewMerge(session, source);
    const byLiveId = new Map(preview.liveWindows.map(entry => [entry.liveId, entry.metaWindow]));
    const results = {
        moved: 0,
        kept: 0,
        launched: 0,
        skipped: 0,
        failed: 0,
        cancelled: false,
        summary: preview.summary,
    };
    let focusWindow = null;
    let step = 0;
    const total = preview.plan.actions.filter(action => action.type === 'launch' || action.type === 'move').length;

    for (const action of preview.plan.actions) {
        if (job.isCancelled()) {
            results.cancelled = true;
            break;
        }
        if (action.type === 'launch' || action.type === 'move') {
            step += 1;
            onProgress?.(progressText(action, step, total));
        }
        if (action.type === 'skip') {
            results.skipped += 1;
            continue;
        }
        if (action.type === 'keep') {
            results.kept += 1;
            const kept = byLiveId.get(action.liveId);
            if (action.focus)
                focusWindow = kept;
            continue;
        }
        if (action.type === 'launch') {
            try {
                const launched = await launchAndPlace(source.display, action, job);
                if (launched.status === 'cancelled') {
                    results.cancelled = true;
                    break;
                }
                if (launched.status === 'launched') {
                    results.launched += 1;
                    if (action.focus)
                        focusWindow = launched.window;
                } else if (launched.status === 'failed') {
                    results.failed += 1;
                } else {
                    results.skipped += 1;
                }
            } catch {
                results.failed += 1;
            }
            continue;
        }
        const window = byLiveId.get(action.liveId);
        if (!window) {
            results.skipped += 1;
            continue;
        }
        try {
            const status = await applyWindowPlacement(
                source.display,
                window,
                action,
                job,
            );
            if (status === 'cancelled') {
                results.cancelled = true;
                break;
            }
            if (status === 'applied')
                results.moved += 1;
            else if (status === 'failed')
                results.failed += 1;
            else
                results.skipped += 1;
            if (action.focus && status === 'applied')
                focusWindow = window;
        } catch {
            results.failed += 1;
        }
    }

    if (results.launched + results.failed > 0 && !job.isCancelled()) {
        await waitForJob(job, SETTLE_DELAY_MS);
        if (!job.isCancelled()) {
            onProgress?.('Placing opened windows…');
            results.moved += await settlePlacement(session, source, job);
        }
    }

    if (!job.isCancelled() && Number.isInteger(session.activeWorkspaceIndex))
        activateWorkspaceAndWindow(source.display, focusWindow, session.activeWorkspaceIndex);

    return results;
}

function waitForJob(job, delay) {
    return new Promise(resolve => {
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            id = 0;
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        job.addCleanup(() => {
            if (id) {
                GLib.Source.remove(id);
                id = 0;
            }
            resolve();
        });
    });
}

/**
 * Applications can open, retitle, or restore windows after their launch was
 * detected. Move windows that now match but are not yet in place. Never launches.
 */
async function settlePlacement(session, source, job) {
    let moved = 0;
    const preview = await previewMerge(session, source);
    const byLiveId = new Map(preview.liveWindows.map(entry => [entry.liveId, entry.metaWindow]));
    for (const action of preview.plan.actions) {
        if (job.isCancelled() || action.type !== 'move')
            continue;
        const window = byLiveId.get(action.liveId);
        if (!window)
            continue;
        try {
            if (await applyWindowPlacement(source.display, window, action, job) === 'applied')
                moved += 1;
        } catch {
            // A window that closed meanwhile is left alone.
        }
    }
    return moved;
}

export function describeResults(results) {
    if (results.cancelled)
        return 'Restore stopped. Windows already moved or opened were left as they are.';
    const parts = [];
    if (results.moved)
        parts.push(`moved ${results.moved}`);
    if (results.launched)
        parts.push(`opened ${results.launched}`);
    if (results.kept)
        parts.push(`already placed ${results.kept}`);
    if (results.skipped)
        parts.push(`left ${results.skipped} unrestored`);
    if (results.failed)
        parts.push(`failed ${results.failed}`);
    if (parts.length === 0)
        return 'Nothing needed to change. Unrelated windows were left alone.';
    return `Restored the session: ${parts.join(', ')}. Unrelated windows were left alone.`;
}
