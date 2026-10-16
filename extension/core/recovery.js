/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createSession, validateSession } from './model.js';

export const RECOVERY_FORMAT = 'workspace-sessions-recovery';
export const RECOVERY_VERSION = 1;
export const RECOVERY_ID = '00000000-0000-4000-8000-000000000001';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function recoverySession(record) {
    return createSession({
        id: RECOVERY_ID,
        name: 'Recovered desktop',
        captured: record.captured,
        now: record.savedAt,
    });
}

/**
 * A crash snapshot is a capture plus a clean flag. It is not a named session.
 */
export function normalizeRecovery(input) {
    if (!isPlainObject(input))
        return null;
    if (input.format !== RECOVERY_FORMAT || input.formatVersion !== RECOVERY_VERSION)
        return null;
    if (typeof input.clean !== 'boolean' || typeof input.savedAt !== 'string')
        return null;
    const validated = validateSession(recoverySession(input));
    if (!validated.ok)
        return null;
    const session = validated.session;
    return {
        clean: input.clean,
        savedAt: input.savedAt,
        captured: {
            environment: session.environment,
            workspaceCount: session.workspaceCount,
            activeWorkspaceIndex: session.activeWorkspaceIndex,
            focusedWindowKey: session.focusedWindowKey,
            workspaceLabels: session.workspaceLabels,
            monitors: session.monitors,
            windows: session.windows,
            captureWarnings: session.captureWarnings,
        },
    };
}
