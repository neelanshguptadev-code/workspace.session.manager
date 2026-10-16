/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { attachChromiumContexts } from '../integrations/chromium.js';
import { attachFirefoxContexts } from '../integrations/firefox.js';
import { attachDocumentContexts } from '../integrations/documents.js';
import { attachDirectoryContexts } from '../integrations/places.js';
import { attachTerminalContexts } from '../integrations/terminal.js';
import { attachCodeContexts } from '../integrations/vscode.js';

const WINDOW_TYPE_NAMES = new Map([
    [Meta.WindowType.NORMAL, 'normal'],
    [Meta.WindowType.DESKTOP, 'desktop'],
    [Meta.WindowType.DOCK, 'dock'],
    [Meta.WindowType.DIALOG, 'dialog'],
    [Meta.WindowType.MODAL_DIALOG, 'modal_dialog'],
    [Meta.WindowType.TOOLBAR, 'toolbar'],
    [Meta.WindowType.MENU, 'menu'],
    [Meta.WindowType.UTILITY, 'utility'],
    [Meta.WindowType.SPLASHSCREEN, 'splashscreen'],
    [Meta.WindowType.DROPDOWN_MENU, 'dropdown_menu'],
    [Meta.WindowType.POPUP_MENU, 'popup_menu'],
    [Meta.WindowType.TOOLTIP, 'tooltip'],
    [Meta.WindowType.NOTIFICATION, 'notification'],
    [Meta.WindowType.COMBO, 'combo'],
    [Meta.WindowType.DND, 'dnd'],
    [Meta.WindowType.OVERRIDE_OTHER, 'override_other'],
]);

function call(warnings, label, fn, fallback = null) {
    try {
        return fn();
    } catch (error) {
        warnings.push(`${label}: ${error.message ?? error}`);
        return fallback;
    }
}

function rectFields(rect) {
    if (!rect)
        return null;
    const frame = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
    if (Object.values(frame).some(value => !Number.isFinite(value)))
        return null;
    if (frame.width < 1 || frame.height < 1)
        return null;
    return frame;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string')
        return null;
    const cleaned = value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .slice(0, maxLength);
    return cleaned.trim() === '' ? null : cleaned;
}

function cleanDesktopId(value, warnings) {
    const text = cleanText(value, 200);
    if (text === null)
        return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.desktop$/.test(text)) {
        warnings.push(`Ignored an unusual application id: ${text.slice(0, 80)}`);
        return null;
    }
    return text;
}

function booleanSetting(schema, key, warnings) {
    return call(warnings, schema, () => {
        const settings = Gio.Settings.new(schema);
        return settings.get_boolean(key);
    }, null);
}

function integerSetting(schema, key, warnings) {
    return call(warnings, `${schema} ${key}`, () => {
        const settings = Gio.Settings.new(schema);
        return settings.get_int(key);
    }, null);
}

function stringArraySetting(schema, key, warnings) {
    return call(warnings, `${schema} ${key}`, () => {
        const settings = Gio.Settings.new(schema);
        return settings.get_strv(key).map(label => label ?? '');
    }, []);
}

function monitorIdentity(backend, warnings) {
    const byIndex = new Map();
    const manager = call(warnings, 'monitor manager', () => backend?.get_monitor_manager?.(), null);
    if (!manager)
        return byIndex;
    const logicalMonitors = call(warnings, 'logical monitors', () => manager.get_logical_monitors(), []) ?? [];
    for (const logical of logicalMonitors) {
        const index = call(warnings, 'logical monitor index', () => logical.get_number(), null);
        const monitors = call(warnings, 'physical monitors', () => logical.get_monitors(), []) ?? [];
        const physical = monitors[0] ?? null;
        if (index === null || !physical)
            continue;
        byIndex.set(index, {
            connector: cleanText(call(warnings, 'connector', () => physical.get_connector(), null), 80),
            vendor: cleanText(call(warnings, 'vendor', () => physical.get_vendor(), null), 80),
            product: cleanText(call(warnings, 'product', () => physical.get_product(), null), 80),
            serial: cleanText(call(warnings, 'serial', () => physical.get_serial(), null), 120),
            primary: Boolean(call(warnings, 'primary', () => physical.is_primary(), false)),
            builtin: Boolean(call(warnings, 'builtin', () => physical.is_builtin(), false)),
        });
    }
    return byIndex;
}

function captureMonitors(display, backend, warnings) {
    const count = call(warnings, 'monitor count', () => display.get_n_monitors(), 0) ?? 0;
    const primary = call(warnings, 'primary monitor', () => display.get_primary_monitor(), 0);
    const identity = monitorIdentity(backend, warnings);
    const monitors = [];
    for (let index = 0; index < count; index++) {
        const geometry = call(warnings, `monitor ${index} geometry`, () => display.get_monitor_geometry(index), null);
        const fields = rectFields(geometry);
        if (!fields) {
            warnings.push(`Monitor ${index} geometry was unavailable`);
            continue;
        }
        const known = identity.get(index) ?? {};
        const scale = call(warnings, `monitor ${index} scale`, () => display.get_monitor_scale(index), null);
        monitors.push({
            index,
            x: fields.x,
            y: fields.y,
            width: fields.width,
            height: fields.height,
            scale: typeof scale === 'number' ? scale : null,
            connector: known.connector ?? null,
            vendor: known.vendor ?? null,
            product: known.product ?? null,
            serial: known.serial ?? null,
            primary: known.primary ?? index === primary,
            builtin: known.builtin ?? false,
        });
    }
    return monitors;
}

function captureWindow(window, monitorByIndex, warnings) {
    const type = call(warnings, 'window type', () => window.get_window_type(), null);
    const typeName = WINDOW_TYPE_NAMES.get(type) ?? 'override_other';
    if (typeName !== 'normal')
        return null;

    const tracker = Shell.WindowTracker.get_default();
    const app = call(warnings, 'window app', () => tracker.get_window_app(window), null);
    const workspace = call(warnings, 'workspace', () => window.get_workspace(), null);
    const monitorIndex = call(warnings, 'window monitor', () => window.get_monitor(), null);
    const monitor = Number.isInteger(monitorIndex) ? monitorByIndex.get(monitorIndex) : null;
    const clientType = call(warnings, 'client type', () => {
        return window.get_client_type() === Meta.WindowClientType.WAYLAND ? 'wayland' : 'x11';
    }, 'unknown');
    const flags = call(warnings, 'maximize flags', () => window.get_maximize_flags(), 0) ?? 0;
    const liveId = call(warnings, 'window id', () => window.get_id(), null);

    return {
        liveId,
        key: GLib.uuid_string_random(),
        app: {
            desktopId: cleanDesktopId(call(warnings, 'desktop id', () => app?.get_id() ?? null, null), warnings),
            name: cleanText(call(warnings, 'app name', () => app?.get_name() ?? null, null), 200),
            gtkApplicationId: cleanText(call(warnings, 'gtk id', () => window.get_gtk_application_id(), null), 200),
            sandboxedAppId: cleanText(call(warnings, 'sandbox id', () => window.get_sandboxed_app_id(), null), 200),
            wmClass: cleanText(call(warnings, 'wm class', () => window.get_wm_class(), null), 200),
            wmClassInstance: cleanText(call(warnings, 'wm instance', () => window.get_wm_class_instance(), null), 200),
        },
        title: cleanText(call(warnings, 'title', () => window.get_title(), null), 500),
        windowType: 'normal',
        clientType,
        workspaceIndex: workspace ? call(warnings, 'workspace index', () => workspace.index(), null) : null,
        onAllWorkspaces: Boolean(call(warnings, 'all workspaces', () => window.is_on_all_workspaces(), false)),
        monitorIndex: Number.isInteger(monitorIndex) && monitorIndex >= 0 ? monitorIndex : null,
        monitorConnector: monitor?.connector ?? null,
        monitorSerial: monitor?.serial ?? null,
        frame: rectFields(call(warnings, 'frame', () => window.get_frame_rect(), null)),
        state: {
            maximizedHorizontally: (flags & Meta.MaximizeFlags.HORIZONTAL) !== 0,
            maximizedVertically: (flags & Meta.MaximizeFlags.VERTICAL) !== 0,
            fullscreen: Boolean(call(warnings, 'fullscreen', () => window.is_fullscreen(), false)),
            minimized: Boolean(call(warnings, 'minimized', () => window.minimized, false)),
            above: Boolean(call(warnings, 'above', () => window.is_above(), false)),
        },
        role: cleanText(call(warnings, 'role', () => window.get_role(), null), 200),
        tag: cleanText(call(warnings, 'tag', () => window.get_tag(), null), 200),
        context: null,
    };
}

function stripLive(record) {
    const { liveId: _liveId, ...rest } = record;
    return rest;
}

/**
 * Read the current desktop. This function does not launch, move, or close windows.
 *
 * @param {{ display: any, backend: any, gnomeShell: string|null, sessionType: string|null }} source
 */
export async function inspectDesktop(source) {
    const warnings = [];
    const display = source.display;
    const workspaceManager = call(warnings, 'workspace manager', () => display.get_workspace_manager(), null);
    const workspaceCount = workspaceManager
        ? call(warnings, 'workspace count', () => workspaceManager.get_n_workspaces(), 1) ?? 1
        : 1;
    const activeWorkspaceIndex = workspaceManager
        ? call(warnings, 'active workspace', () => workspaceManager.get_active_workspace_index(), 0) ?? 0
        : 0;
    const monitors = captureMonitors(display, source.backend, warnings);
    const monitorByIndex = new Map(monitors.map(monitor => [monitor.index, monitor]));
    const windows = [];
    const liveWindows = [];
    const capturedWindows = [];
    let skipped = 0;
    let focusedWindowKey = null;
    const focus = call(warnings, 'focus', () => display.get_focus_window(), null);
    const metaWindows = call(warnings, 'window list', () => display.list_all_windows(), []) ?? [];
    for (const metaWindow of metaWindows) {
        const captured = captureWindow(metaWindow, monitorByIndex, warnings);
        if (!captured) {
            skipped += 1;
            continue;
        }
        capturedWindows.push({ metaWindow, captured });
    }
    const capturedRecords = capturedWindows.map(entry => entry.captured);
    await attachChromiumContexts(capturedRecords, warnings);
    await attachFirefoxContexts(capturedRecords, warnings);
    await attachCodeContexts(capturedRecords, warnings);
    await attachDirectoryContexts(capturedRecords, warnings);
    await attachDocumentContexts(capturedRecords, warnings);
    await attachTerminalContexts(capturedRecords, warnings);
    for (const { metaWindow, captured } of capturedWindows) {
        if (metaWindow === focus)
            focusedWindowKey = captured.key;
        windows.push(stripLive(captured));
        if (captured.liveId !== null && captured.liveId !== undefined)
            liveWindows.push({ liveId: captured.liveId, metaWindow, record: captured });
    }
    if (skipped > 0)
        warnings.push(`Skipped ${skipped} windows that are not normal application windows`);
    if (focus && !focusedWindowKey)
        warnings.push('The focused window is not a normal application window, so focus was not stored');

    return {
        captured: {
            environment: {
                gnomeShell: source.gnomeShell,
                sessionType: source.sessionType,
                dynamicWorkspaces: booleanSetting('org.gnome.mutter', 'dynamic-workspaces', warnings),
                workspacesOnlyOnPrimary: booleanSetting('org.gnome.mutter', 'workspaces-only-on-primary', warnings),
                workspaceCountSetting: integerSetting('org.gnome.desktop.wm.preferences', 'num-workspaces', warnings),
            },
            workspaceCount,
            activeWorkspaceIndex,
            focusedWindowKey,
            workspaceLabels: stringArraySetting('org.gnome.desktop.wm.preferences', 'workspace-names', warnings)
                .map(label => (cleanText(label, 80) ?? '').trim()),
            monitors,
            windows,
            captureWarnings: capWarnings(warnings),
        },
        liveWindows,
    };
}

export async function captureDesktop(source) {
    return (await inspectDesktop(source)).captured;
}

function capWarnings(warnings) {
    if (warnings.length <= 40)
        return warnings;
    const hidden = warnings.length - 39;
    return [...warnings.slice(0, 39), `${hidden} more capture warnings were omitted`];
}
