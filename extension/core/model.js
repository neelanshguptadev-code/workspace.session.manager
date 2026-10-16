/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const FORMAT = 'workspace-sessions';
export const FORMAT_VERSION = 1;
export const MAX_SESSION_BYTES = 2 * 1024 * 1024;
export const MAX_WORKSPACES = 36;
export const MAX_WINDOWS = 500;

const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.desktop$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const WINDOW_TYPES = new Set([
    'normal', 'desktop', 'dock', 'dialog', 'modal_dialog', 'toolbar', 'menu',
    'utility', 'splashscreen', 'dropdown_menu', 'popup_menu', 'tooltip',
    'notification', 'combo', 'dnd', 'override_other',
]);
const CLIENT_TYPES = new Set(['wayland', 'x11', 'unknown']);
const FORBIDDEN_KEYS = new Set([
    'command', 'exec', 'shell', 'argv', 'script', 'cookies', 'password',
    'token', 'secret', 'credentials', 'history', '__proto__', 'constructor',
    'prototype',
]);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushForbidden(value, path, errors, depth) {
    if (depth > 8) {
        errors.push(`${path} is nested too deeply`);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => pushForbidden(item, `${path}[${index}]`, errors, depth + 1));
        return;
    }
    if (!isPlainObject(value))
        return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(String(key).toLowerCase()))
            errors.push(`${path}.${key} is not allowed in a session file`);
        else
            pushForbidden(value[key], `${path}.${key}`, errors, depth + 1);
    }
}

function requireString(value, path, errors, { max = 300, allowNull = false, allowEmpty = false } = {}) {
    if (value === null && allowNull)
        return null;
    if (typeof value !== 'string') {
        errors.push(`${path} must be a string`);
        return null;
    }
    if (value.includes('\0') || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
        errors.push(`${path} contains a control character`);
        return null;
    }
    if (!allowEmpty && value.trim() === '') {
        errors.push(`${path} is empty`);
        return null;
    }
    if (value.length > max) {
        errors.push(`${path} is too long`);
        return null;
    }
    return value;
}

function requireInteger(value, path, errors, { min, max }) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        errors.push(`${path} must be an integer from ${min} to ${max}`);
        return null;
    }
    return value;
}

function requireBoolean(value, path, errors) {
    if (typeof value !== 'boolean') {
        errors.push(`${path} must be a boolean`);
        return false;
    }
    return value;
}

function optionalBoolean(value, path, errors) {
    if (value === null || value === undefined)
        return null;
    return requireBoolean(value, path, errors);
}

function normalizeFrame(frame, path, errors) {
    if (frame === null)
        return null;
    if (!isPlainObject(frame)) {
        errors.push(`${path} must be an object or null`);
        return null;
    }
    return {
        x: requireInteger(frame.x, `${path}.x`, errors, { min: -100000, max: 100000 }),
        y: requireInteger(frame.y, `${path}.y`, errors, { min: -100000, max: 100000 }),
        width: requireInteger(frame.width, `${path}.width`, errors, { min: 1, max: 100000 }),
        height: requireInteger(frame.height, `${path}.height`, errors, { min: 1, max: 100000 }),
    };
}

function normalizeApp(app, path, errors) {
    if (!isPlainObject(app)) {
        errors.push(`${path} must be an object`);
        return null;
    }
    const desktopId = requireString(app.desktopId, `${path}.desktopId`, errors, {
        max: 200,
        allowNull: true,
    });
    if (desktopId !== null && !DESKTOP_ID.test(desktopId))
        errors.push(`${path}.desktopId is not a desktop file id`);
    return {
        desktopId,
        name: requireString(app.name, `${path}.name`, errors, { max: 200, allowNull: true }),
        gtkApplicationId: requireString(app.gtkApplicationId, `${path}.gtkApplicationId`, errors, {
            max: 200,
            allowNull: true,
        }),
        sandboxedAppId: requireString(app.sandboxedAppId, `${path}.sandboxedAppId`, errors, {
            max: 200,
            allowNull: true,
        }),
        wmClass: requireString(app.wmClass, `${path}.wmClass`, errors, { max: 200, allowNull: true }),
        wmClassInstance: requireString(app.wmClassInstance, `${path}.wmClassInstance`, errors, {
            max: 200,
            allowNull: true,
        }),
    };
}

function normalizeState(state, path, errors) {
    if (!isPlainObject(state)) {
        errors.push(`${path} must be an object`);
        return null;
    }
    return {
        maximizedHorizontally: requireBoolean(state.maximizedHorizontally, `${path}.maximizedHorizontally`, errors),
        maximizedVertically: requireBoolean(state.maximizedVertically, `${path}.maximizedVertically`, errors),
        fullscreen: requireBoolean(state.fullscreen, `${path}.fullscreen`, errors),
        minimized: requireBoolean(state.minimized, `${path}.minimized`, errors),
        above: requireBoolean(state.above, `${path}.above`, errors),
    };
}

function jsonSize(value) {
    try {
        return JSON.stringify(value).length;
    } catch {
        return Infinity;
    }
}

function normalizeContext(context, path, errors) {
    if (context === null || context === undefined)
        return null;
    if (!isPlainObject(context)) {
        errors.push(`${path} must be an object or null`);
        return null;
    }
    const provider = requireString(context.provider, `${path}.provider`, errors, { max: 40 });
    if (provider !== null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(provider))
        errors.push(`${path}.provider must be a short lowercase id`);
    if (!isPlainObject(context.data)) {
        errors.push(`${path}.data must be an object`);
        return null;
    }
    if (jsonSize(context.data) > 100000)
        errors.push(`${path}.data is too large`);
    return {
        provider,
        data: context.data,
    };
}

function normalizeWindow(windowRecord, path, errors) {
    if (!isPlainObject(windowRecord)) {
        errors.push(`${path} must be an object`);
        return null;
    }
    const key = requireString(windowRecord.key, `${path}.key`, errors, { max: 80 });
    if (key !== null && !UUID.test(key))
        errors.push(`${path}.key must be a UUID`);
    const windowType = requireString(windowRecord.windowType, `${path}.windowType`, errors, { max: 40 });
    if (windowType !== null && !WINDOW_TYPES.has(windowType))
        errors.push(`${path}.windowType is unknown`);
    const clientType = requireString(windowRecord.clientType, `${path}.clientType`, errors, { max: 20 });
    if (clientType !== null && !CLIENT_TYPES.has(clientType))
        errors.push(`${path}.clientType is unknown`);
    const workspaceIndex = windowRecord.workspaceIndex === null
        ? null
        : requireInteger(windowRecord.workspaceIndex, `${path}.workspaceIndex`, errors, {
            min: 0,
            max: MAX_WORKSPACES - 1,
        });
    const monitorIndex = windowRecord.monitorIndex === null
        ? null
        : requireInteger(windowRecord.monitorIndex, `${path}.monitorIndex`, errors, { min: 0, max: 32 });
    return {
        key,
        app: normalizeApp(windowRecord.app, `${path}.app`, errors),
        title: requireString(windowRecord.title, `${path}.title`, errors, {
            max: 500,
            allowNull: true,
        }),
        windowType,
        clientType,
        workspaceIndex,
        onAllWorkspaces: requireBoolean(windowRecord.onAllWorkspaces, `${path}.onAllWorkspaces`, errors),
        monitorIndex,
        monitorConnector: requireString(windowRecord.monitorConnector, `${path}.monitorConnector`, errors, {
            max: 80,
            allowNull: true,
        }),
        monitorSerial: requireString(windowRecord.monitorSerial, `${path}.monitorSerial`, errors, {
            max: 120,
            allowNull: true,
        }),
        frame: normalizeFrame(windowRecord.frame, `${path}.frame`, errors),
        state: normalizeState(windowRecord.state, `${path}.state`, errors),
        role: requireString(windowRecord.role, `${path}.role`, errors, { max: 200, allowNull: true }),
        tag: requireString(windowRecord.tag, `${path}.tag`, errors, { max: 200, allowNull: true }),
        context: normalizeContext(windowRecord.context, `${path}.context`, errors),
    };
}

function normalizeMonitor(monitor, path, errors) {
    if (!isPlainObject(monitor)) {
        errors.push(`${path} must be an object`);
        return null;
    }
    let scale = null;
    if (monitor.scale !== null && monitor.scale !== undefined) {
        if (typeof monitor.scale !== 'number' || !Number.isFinite(monitor.scale) || monitor.scale < 0.5 || monitor.scale > 10)
            errors.push(`${path}.scale must be a number from 0.5 to 10`);
        else
            scale = monitor.scale;
    }
    return {
        index: requireInteger(monitor.index, `${path}.index`, errors, { min: 0, max: 32 }),
        x: requireInteger(monitor.x, `${path}.x`, errors, { min: -100000, max: 100000 }),
        y: requireInteger(monitor.y, `${path}.y`, errors, { min: -100000, max: 100000 }),
        width: requireInteger(monitor.width, `${path}.width`, errors, { min: 1, max: 100000 }),
        height: requireInteger(monitor.height, `${path}.height`, errors, { min: 1, max: 100000 }),
        scale,
        connector: requireString(monitor.connector, `${path}.connector`, errors, { max: 80, allowNull: true }),
        vendor: requireString(monitor.vendor, `${path}.vendor`, errors, { max: 80, allowNull: true }),
        product: requireString(monitor.product, `${path}.product`, errors, { max: 80, allowNull: true }),
        serial: requireString(monitor.serial, `${path}.serial`, errors, { max: 120, allowNull: true }),
        primary: requireBoolean(monitor.primary, `${path}.primary`, errors),
        builtin: requireBoolean(monitor.builtin, `${path}.builtin`, errors),
    };
}

function normalizeEnvironment(environment, errors) {
    const source = isPlainObject(environment) ? environment : {};
    if (!isPlainObject(environment))
        errors.push('environment must be an object');
    const workspaceCountSetting = source.workspaceCountSetting === null || source.workspaceCountSetting === undefined
        ? null
        : requireInteger(source.workspaceCountSetting, 'environment.workspaceCountSetting', errors, {
            min: 1,
            max: MAX_WORKSPACES,
        });
    return {
        gnomeShell: requireString(source.gnomeShell, 'environment.gnomeShell', errors, {
            max: 40,
            allowNull: true,
        }),
        sessionType: requireString(source.sessionType, 'environment.sessionType', errors, {
            max: 40,
            allowNull: true,
        }),
        dynamicWorkspaces: optionalBoolean(source.dynamicWorkspaces, 'environment.dynamicWorkspaces', errors),
        workspacesOnlyOnPrimary: optionalBoolean(
            source.workspacesOnlyOnPrimary,
            'environment.workspacesOnlyOnPrimary',
            errors,
        ),
        workspaceCountSetting,
    };
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, session: object } | { ok: false, errors: string[] }}
 */
export function validateSession(input) {
    const errors = [];
    if (!isPlainObject(input))
        return { ok: false, errors: ['Session must be a JSON object'] };

    pushForbidden(input, 'session', errors, 0);
    if (input.format !== FORMAT)
        errors.push(`format must be ${FORMAT}`);
    if (input.formatVersion !== FORMAT_VERSION)
        errors.push(`formatVersion ${input.formatVersion} is not supported`);

    const id = requireString(input.id, 'id', errors, { max: 80 });
    if (id !== null && !UUID.test(id))
        errors.push('id must be a UUID');
    const name = requireString(input.name, 'name', errors, { max: 80 });
    const createdAt = requireString(input.createdAt, 'createdAt', errors, { max: 40 });
    const updatedAt = requireString(input.updatedAt, 'updatedAt', errors, { max: 40 });
    if (createdAt !== null && !ISO_TIME.test(createdAt))
        errors.push('createdAt must be a UTC timestamp');
    if (updatedAt !== null && !ISO_TIME.test(updatedAt))
        errors.push('updatedAt must be a UTC timestamp');

    const environment = normalizeEnvironment(input.environment, errors);
    const workspaceCount = requireInteger(input.workspaceCount, 'workspaceCount', errors, {
        min: 1,
        max: MAX_WORKSPACES,
    });
    const activeWorkspaceIndex = requireInteger(input.activeWorkspaceIndex, 'activeWorkspaceIndex', errors, {
        min: 0,
        max: MAX_WORKSPACES - 1,
    });
    const focusedWindowKey = requireString(input.focusedWindowKey, 'focusedWindowKey', errors, {
        max: 80,
        allowNull: true,
    });
    if (focusedWindowKey !== null && !UUID.test(focusedWindowKey))
        errors.push('focusedWindowKey must be a UUID or null');

    const workspaceLabels = [];
    if (!Array.isArray(input.workspaceLabels)) {
        errors.push('workspaceLabels must be an array');
    } else if (input.workspaceLabels.length > MAX_WORKSPACES) {
        errors.push('workspaceLabels is too long');
    } else {
        input.workspaceLabels.forEach((label, index) => {
            workspaceLabels.push(requireString(label, `workspaceLabels[${index}]`, errors, {
                max: 80,
                allowEmpty: true,
            }));
        });
    }

    const captureWarnings = [];
    if (!Array.isArray(input.captureWarnings)) {
        errors.push('captureWarnings must be an array');
    } else if (input.captureWarnings.length > 50) {
        errors.push('captureWarnings is too long');
    } else {
        input.captureWarnings.forEach((warning, index) => {
            const text = requireString(warning, `captureWarnings[${index}]`, errors, { max: 300 });
            if (text !== null)
                captureWarnings.push(text);
        });
    }

    const monitors = [];
    if (!Array.isArray(input.monitors))
        errors.push('monitors must be an array');
    else if (input.monitors.length > 32)
        errors.push('monitors is too long');
    else
        input.monitors.forEach((monitor, index) => {
            monitors.push(normalizeMonitor(monitor, `monitors[${index}]`, errors));
        });

    const windows = [];
    if (!Array.isArray(input.windows))
        errors.push('windows must be an array');
    else if (input.windows.length > MAX_WINDOWS)
        errors.push('windows is too long');
    else
        input.windows.forEach((windowRecord, index) => {
            windows.push(normalizeWindow(windowRecord, `windows[${index}]`, errors));
        });

    const keys = new Set(windows.map(windowRecord => windowRecord?.key).filter(Boolean));
    if (keys.size !== windows.filter(windowRecord => windowRecord?.key).length)
        errors.push('window keys must be unique');
    if (focusedWindowKey !== null && !keys.has(focusedWindowKey))
        errors.push('focusedWindowKey does not match a saved window');

    if (errors.length > 0)
        return { ok: false, errors };

    return {
        ok: true,
        session: {
            format: FORMAT,
            formatVersion: FORMAT_VERSION,
            id,
            name: name.trim(),
            createdAt,
            updatedAt,
            environment,
            workspaceCount,
            activeWorkspaceIndex,
            focusedWindowKey,
            workspaceLabels,
            monitors,
            windows,
            captureWarnings,
        },
    };
}

export function createSession({ id, name, captured, now }) {
    return {
        format: FORMAT,
        formatVersion: FORMAT_VERSION,
        id,
        name: name.trim(),
        createdAt: now,
        updatedAt: now,
        environment: captured.environment,
        workspaceCount: captured.workspaceCount,
        activeWorkspaceIndex: captured.activeWorkspaceIndex,
        focusedWindowKey: captured.focusedWindowKey,
        workspaceLabels: captured.workspaceLabels,
        monitors: captured.monitors,
        windows: captured.windows,
        captureWarnings: captured.captureWarnings,
    };
}

export function withUpdatedCapture(existing, captured, now) {
    return {
        ...existing,
        updatedAt: now,
        environment: captured.environment,
        workspaceCount: captured.workspaceCount,
        activeWorkspaceIndex: captured.activeWorkspaceIndex,
        focusedWindowKey: captured.focusedWindowKey,
        workspaceLabels: captured.workspaceLabels,
        monitors: captured.monitors,
        windows: captured.windows,
        captureWarnings: captured.captureWarnings,
    };
}

export function duplicateSession(existing, id, now) {
    const base = existing.name.trim();
    const name = base.length > 72 ? `${base.slice(0, 72).trim()} copy` : `${base} copy`;
    return {
        ...existing,
        id,
        name,
        createdAt: now,
        updatedAt: now,
    };
}

function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort()
            .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

function windowSignature(windowRecord) {
    const app = windowRecord.app ?? {};
    const identity = (app.desktopId || app.gtkApplicationId || app.sandboxedAppId || app.wmClass || '').toLowerCase();
    const place = windowRecord.onAllWorkspaces ? 'all' : String(windowRecord.workspaceIndex ?? '');
    const context = windowRecord.context
        ? `${windowRecord.context.provider}:${stableJson(windowRecord.context.data)}`
        : '';
    return `${identity}|${place}|${context}`;
}

/**
 * Describe what a session would reopen: which apps, on which workspaces, with
 * which tabs or folders. Titles and pixel positions are ignored.
 */
export function sessionSignature(session) {
    return (session?.windows ?? []).map(windowSignature).sort().join('\n');
}

export function findSameSession(captured, sessions) {
    const signature = sessionSignature(captured);
    if (!signature)
        return null;
    return (sessions ?? []).find(session => sessionSignature(session) === signature) ?? null;
}

export function renameSession(existing, name) {
    return {
        ...existing,
        name: name.trim(),
    };
}

/**
 * Put back the desktop captured before the last update. The current name stays.
 */
export function restorePreviousCapture(current, previous) {
    return {
        ...previous,
        name: current.name,
        createdAt: current.createdAt,
    };
}

/**
 * Limit a restore to chosen windows or workspaces. An empty windowKeys list
 * restores nothing. Sticky windows are included only when their own key is chosen.
 */
export function sessionForSelection(session, selection) {
    const byKeys = Array.isArray(selection?.windowKeys);
    const workspaces = !byKeys && Array.isArray(selection?.workspaceIndexes)
        ? new Set(selection.workspaceIndexes)
        : null;
    const keys = byKeys ? new Set(selection.windowKeys) : null;
    const windows = (session.windows ?? []).filter(windowRecord => {
        if (keys)
            return keys.has(windowRecord.key);
        if (!workspaces)
            return true;
        return !windowRecord.onAllWorkspaces && workspaces.has(windowRecord.workspaceIndex);
    });
    const focusedWindowKey = windows.some(windowRecord => windowRecord.key === session.focusedWindowKey)
        ? session.focusedWindowKey
        : null;
    const indexes = windows.map(windowRecord => windowRecord.workspaceIndex).filter(Number.isInteger);
    let activeWorkspaceIndex = session.activeWorkspaceIndex;
    if (indexes.length > 0 && !indexes.includes(activeWorkspaceIndex))
        activeWorkspaceIndex = Math.min(...indexes);
    return {
        ...session,
        windows,
        focusedWindowKey,
        activeWorkspaceIndex,
    };
}
