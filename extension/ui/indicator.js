/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    createSession,
    duplicateSession,
    findSameSession,
    renameSession,
    restorePreviousCapture,
    sessionForSelection,
    withUpdatedCapture,
} from '../core/model.js';
import {
    defaultUndoDirectory,
    deleteSession,
    listSessions,
    readSession,
    writeSession,
} from '../core/storage.js';
import { captureDesktop } from '../gnome/inspector.js';
import {
    createRestoreJob,
    describeResults,
    mergeRestore,
    previewMerge,
} from '../gnome/restore.js';

const MAX_DETAIL_WINDOWS = 20;
const MAX_PARTIAL_WINDOWS = 40;

const ACTION_WORDS = {
    move: 'will be moved',
    launch: 'will be opened',
    keep: 'already in place',
    skip: 'will be left alone',
};

/**
 * A menu row that runs its callback without closing the menu.
 */
const StayOpenMenuItem = GObject.registerClass(
class StayOpenMenuItem extends PopupMenu.PopupMenuItem {
    _init(text, callback) {
        super._init(text);
        this._callback = callback;
    }

    activate(_event) {
        if (!this.sensitive)
            return;
        this._callback?.();
    }
});

function timestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function notify(body) {
    Main.notify('Workspace Sessions', body);
}

function clockFormat() {
    try {
        return Gio.Settings.new('org.gnome.desktop.interface').get_string('clock-format');
    } catch {
        return '24h';
    }
}

export function formatLocalTime(iso) {
    const parsed = GLib.DateTime.new_from_iso8601(iso, null);
    if (!parsed)
        return iso;
    const local = parsed.to_local();
    const now = GLib.DateTime.new_now_local();
    const time = clockFormat() === '12h' ? '%l:%M %p' : '%H:%M';
    let day = '%e %b %Y';
    if (local.get_year() === now.get_year() && local.get_day_of_year() === now.get_day_of_year())
        day = 'Today';
    else if (local.get_year() === now.get_year())
        day = '%e %b';
    return local.format(`${day}, ${time}`).replace(/\s+/g, ' ').trim();
}

function windowCountLabel(session) {
    const count = session.windows.length;
    return `${session.name} · ${count} ${count === 1 ? 'window' : 'windows'}`;
}

function contextLabel(context) {
    const data = context?.data;
    if (!data)
        return '';
    const count = items => `${items.length} ${items.length === 1 ? 'tab' : 'tabs'}`;
    switch (context.provider) {
    case 'chromium':
        return data.urls?.length ? count(data.urls) : 'saved profile';
    case 'firefox':
        return data.urls?.length ? count(data.urls) : '';
    case 'vscode':
        return (data.folder ?? data.workspaceFile ?? '').split('/').filter(Boolean).pop() ?? '';
    case 'directory':
        return data.path === GLib.get_home_dir() ? 'Home' : GLib.path_get_basename(data.path ?? '');
    case 'terminal': {
        const first = data.directories?.[0] ?? '';
        const name = first === GLib.get_home_dir() ? '~' : GLib.path_get_basename(first);
        return data.directories?.length > 1 ? `${name} +${data.directories.length - 1}` : name;
    }
    case 'document':
        return GLib.path_get_basename(data.path ?? '');
    default:
        return '';
    }
}

function windowLabel(windowRecord) {
    return windowRecord.app?.name || windowRecord.app?.desktopId || windowRecord.title || 'Window';
}

function workspaceLabel(windowRecord) {
    if (windowRecord.onAllWorkspaces)
        return 'all workspaces';
    return Number.isInteger(windowRecord.workspaceIndex) ? `workspace ${windowRecord.workspaceIndex + 1}` : 'any workspace';
}

function workspaceName(session, index) {
    const label = session.workspaceLabels?.[index];
    if (typeof label === 'string' && label.trim())
        return label.trim();
    return `Workspace ${index + 1}`;
}

function partialChoiceLabel(windowRecord, included, placed = false) {
    const context = contextLabel(windowRecord.context);
    let text = placed ? windowLabel(windowRecord) : `${included ? '●' : '○'} ${windowLabel(windowRecord)}`;
    if (context)
        text += ` (${context})`;
    return `${text} · ${placed ? 'already in place' : workspaceLabel(windowRecord)}`;
}

async function readUndo(id) {
    try {
        return await readSession(id, defaultUndoDirectory());
    } catch {
        return null;
    }
}

function detailLine(windowRecord, action) {
    const context = contextLabel(windowRecord.context);
    const parts = [windowLabel(windowRecord)];
    if (context)
        parts[0] += ` (${context})`;
    parts.push(workspaceLabel(windowRecord));
    if (action)
        parts.push(ACTION_WORDS[action.type] ?? action.type);
    return parts.join(' · ');
}

function captureNow(gnomeShell) {
    return captureDesktop({
        display: global.display,
        backend: global.backend,
        gnomeShell,
        sessionType: GLib.getenv('XDG_SESSION_TYPE'),
    });
}

function showAlreadySavedDialog(existing, onSaveAnyway) {
    const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
        title: 'Session already exists',
        description: `This desktop is already saved as “${existing.name}”. Saving again would make an identical copy.`,
    }));
    dialog.setButtons([
        {
            label: 'Cancel',
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
            default: true,
        },
        {
            label: 'Save anyway',
            action: () => {
                dialog.close();
                onSaveAnyway();
            },
        },
    ]);
    dialog.open();
}

export const SessionIndicator = GObject.registerClass(
class SessionIndicator extends PanelMenu.Button {
    _init(gnomeShell, extensionPath) {
        super._init(0.0, 'Workspace Sessions', false);
        this._gnomeShell = gnomeShell;
        this._restoreJob = null;
        this._restoring = false;
        this._progressItem = null;
        this._cancelItem = null;
        this._progressText = '';
        this._crashRecovery = null;
        this._recoveryDialog = null;
        const iconPath = extensionPath
            ? GLib.build_filenamev([extensionPath, 'icons', 'workspace-sessions-symbolic.svg'])
            : null;
        this.add_child(new St.Icon({
            gicon: iconPath ? Gio.icon_new_for_string(iconPath) : null,
            icon_name: iconPath ? null : 'focus-windows-symbolic',
            style_class: 'system-status-icon',
        }));
        this._menuGeneration = 0;
        this._openStateId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this._rebuild();
        });
        this._rebuild();
    }

    _rebuild() {
        const generation = this._menuGeneration + 1;
        this._menuGeneration = generation;
        this._rebuildMenu(generation).catch(error => {
            if (generation !== this._menuGeneration || !this.menu)
                return;
            this.menu.removeAll();
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `Could not read sessions: ${error.message}`,
                { reactive: false },
            ));
        });
    }

    async _rebuildMenu(generation) {
        let listed;
        try {
            listed = await listSessions();
        } catch (error) {
            if (generation !== this._menuGeneration || !this.menu)
                return;
            this.menu.removeAll();
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `Could not read sessions: ${error.message}`,
                { reactive: false },
            ));
            return;
        }
        if (generation !== this._menuGeneration || !this.menu)
            return;

        this.menu.removeAll();
        this._progressItem = null;
        this._cancelItem = null;
        if (this._restoring) {
            this._cancelItem = new StayOpenMenuItem('Cancel restore', () => {
                this._restoreJob?.cancel();
            });
            this.menu.addMenuItem(this._cancelItem);
            this._progressItem = new PopupMenu.PopupMenuItem(this._progressText || 'Restoring…', { reactive: false });
            this._progressItem.label.add_style_class_name('workspace-sessions-meta');
            this.menu.addMenuItem(this._progressItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        if (this._crashRecovery) {
            const when = formatLocalTime(this._crashRecovery.savedAt);
            this.menu.addAction(`Recover desktop from ${when}`, () => {
                this._crashRecovery?.restore();
            });
            this.menu.addAction('Discard recovered desktop', () => {
                this._crashRecovery?.dismiss();
            });
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        this._addSaveRow();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (listed.sessions.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No saved sessions',
                { reactive: false },
            ));
        }
        for (const session of listed.sessions)
            await this._addSession(session);
        for (const message of listed.errors) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                message,
                { reactive: false },
            ));
        }
    }

    _rebuildSoon() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.menu)
                this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _addSaveRow() {
        const row = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const entry = new St.Entry({
            hint_text: 'New session name',
            style_class: 'workspace-sessions-entry',
            can_focus: true,
            x_expand: true,
        });
        const button = new St.Button({
            label: 'Save',
            style_class: 'button',
            can_focus: true,
        });
        const save = async () => {
            const name = entry.get_text().trim();
            if (!name) {
                notify('Enter a session name before saving.');
                return;
            }
            let captured;
            try {
                captured = await captureNow(this._gnomeShell);
            } catch (error) {
                notify(`Could not save the session: ${error.message}`);
                return;
            }
            const write = () => {
                try {
                    const session = createSession({
                        id: GLib.uuid_string_random(),
                        name,
                        captured,
                        now: timestamp(),
                    });
                    writeSession(session);
                    entry.set_text('');
                    notify(`Saved “${session.name}” with ${session.windows.length} windows.`);
                    this._rebuildSoon();
                } catch (error) {
                    notify(`Could not save the session: ${error.message}`);
                }
            };
            let saved = [];
            try {
                saved = (await listSessions()).sessions;
            } catch {
                saved = [];
            }
            const existing = findSameSession(captured, saved);
            if (existing) {
                this.menu.close();
                showAlreadySavedDialog(existing, write);
                return;
            }
            write();
        };
        entry.clutter_text.connect('activate', save);
        button.connect('clicked', save);
        row.add_child(entry);
        row.add_child(button);
        this.menu.addMenuItem(row);
    }

    async _addSession(session) {
        const item = new PopupMenu.PopupSubMenuMenuItem(windowCountLabel(session), false);
        this._addRenameControl(item, session);

        const updated = new PopupMenu.PopupMenuItem(
            `Last updated ${formatLocalTime(session.updatedAt)}`,
            { reactive: false },
        );
        updated.label.add_style_class_name('workspace-sessions-meta');
        item.menu.addMenuItem(updated);

        const details = new PopupMenu.PopupMenuSection();
        let detailsShown = false;
        const detailsItem = new StayOpenMenuItem('Details', () => {
            detailsShown = !detailsShown;
            details.removeAll();
            if (detailsShown)
                this._fillDetails(details, session).catch(() => {});
            detailsItem.label.text = detailsShown ? 'Hide details' : 'Details';
        });
        item.menu.addMenuItem(detailsItem);
        item.menu.addMenuItem(details);

        const restoreItem = new StayOpenMenuItem(this._restoring ? 'Restore in progress…' : 'Restore', () => {
            this._runRestore(session.id);
        });
        if (this._restoring)
            restoreItem.setSensitive(false);
        item.menu.addMenuItem(restoreItem);
        this._addPartialRestore(item, session);

        item.menu.addAction('Update from current desktop', async () => {
            try {
                const existing = await readSession(session.id);
                const updatedSession = withUpdatedCapture(existing, await captureNow(this._gnomeShell), timestamp());
                writeSession(existing, defaultUndoDirectory());
                try {
                    writeSession(updatedSession);
                } catch (error) {
                    try {
                        deleteSession(existing.id, defaultUndoDirectory());
                    } catch {
                        // The previous copy could not be removed after a failed update.
                    }
                    throw error;
                }
                notify(`Updated “${updatedSession.name}”. Undo update puts the previous desktop back.`);
                this._rebuildSoon();
            } catch (error) {
                notify(`Could not update the session: ${error.message}`);
            }
        });
        const previous = await readUndo(session.id);
        if (previous) {
            item.menu.addAction('Undo update', async () => {
                try {
                    const current = await readSession(session.id);
                    writeSession(restorePreviousCapture(current, previous));
                    deleteSession(session.id, defaultUndoDirectory());
                    notify(`Reverted “${current.name}” to the desktop from ${formatLocalTime(previous.updatedAt)}.`);
                    this._rebuildSoon();
                } catch (error) {
                    notify(`Could not undo the update: ${error.message}`);
                }
            });
        }

        item.menu.addAction('Duplicate', async () => {
            try {
                const existing = await readSession(session.id);
                const copy = duplicateSession(existing, GLib.uuid_string_random(), timestamp());
                writeSession(copy);
                notify(`Duplicated “${existing.name}”.`);
            } catch (error) {
                notify(`Could not duplicate the session: ${error.message}`);
            }
        });

        let confirming = false;
        const deleteItem = new StayOpenMenuItem('Delete', () => {
            if (!confirming) {
                confirming = true;
                deleteItem.label.text = 'Click again to delete';
                deleteItem.label.add_style_class_name('workspace-sessions-danger');
                return;
            }
            try {
                deleteSession(session.id);
                try {
                    deleteSession(session.id, defaultUndoDirectory());
                } catch {
                    // There may be no previous copy.
                }
                notify(`Deleted “${session.name}”.`);
                this._rebuildSoon();
            } catch (error) {
                notify(`Could not delete the session: ${error.message}`);
            }
        });
        item.menu.addMenuItem(deleteItem);
        item.menu.connect('open-state-changed', (_menu, open) => {
            if (open || !confirming)
                return;
            confirming = false;
            deleteItem.label.text = 'Delete';
            deleteItem.label.remove_style_class_name('workspace-sessions-danger');
        });

        this.menu.addMenuItem(item);
    }

    _addRenameControl(item, session) {
        const button = new St.Button({
            style_class: 'workspace-sessions-rename',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Rename',
            child: new St.Icon({
                icon_name: 'document-edit-symbolic',
                style_class: 'workspace-sessions-rename-icon',
            }),
        });
        item.insert_child_above(button, item.label);

        let entry = null;
        const finish = () => {
            if (!entry)
                return;
            entry.destroy();
            entry = null;
            item.label.show();
            button.show();
        };
        const commit = async () => {
            const name = entry?.get_text().trim() ?? '';
            if (!name || name === session.name) {
                finish();
                return;
            }
            try {
                const renamed = renameSession(await readSession(session.id), name);
                writeSession(renamed);
                session.name = renamed.name;
                item.label.text = windowCountLabel(session);
                notify(`Renamed session to “${renamed.name}”.`);
            } catch (error) {
                notify(`Could not rename the session: ${error.message}`);
            }
            finish();
        };

        button.connect('clicked', () => {
            if (entry)
                return;
            entry = new St.Entry({
                text: session.name,
                style_class: 'workspace-sessions-entry',
                can_focus: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.label.hide();
            button.hide();
            item.insert_child_above(entry, item.label);
            entry.clutter_text.connect('activate', commit);
            entry.clutter_text.connect('key-press-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    finish();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            entry.grab_key_focus();
            entry.clutter_text.set_selection(0, session.name.length);
        });
    }

    async _fillDetails(section, session) {
        const addLine = (text, extraClass = null) => {
            const line = new PopupMenu.PopupMenuItem(text, { reactive: false });
            line.label.add_style_class_name('workspace-sessions-detail');
            if (extraClass)
                line.label.add_style_class_name(extraClass);
            section.addMenuItem(line);
        };

        let preview;
        try {
            preview = await previewMerge(await readSession(session.id), this._desktopSource());
        } catch (error) {
            addLine(`Could not read this session: ${error.message}`);
            return;
        }

        const { summary } = preview.plan;
        const counts = [];
        if (summary.move)
            counts.push(`${summary.move} will be moved`);
        if (summary.launch)
            counts.push(`${summary.launch} will be opened`);
        if (summary.keep)
            counts.push(`${summary.keep} already in place`);
        if (summary.skip)
            counts.push(`${summary.skip} left alone`);
        addLine(counts.length ? counts.join(' · ') : 'Nothing to change', 'workspace-sessions-detail-heading');
        addLine('Nothing open will be closed.');

        const actions = new Map(preview.plan.actions.map(action => [action.savedKey, action]));
        const windows = [...preview.windows].sort((left, right) => {
            return (left.workspaceIndex ?? 99) - (right.workspaceIndex ?? 99) ||
                windowLabel(left).localeCompare(windowLabel(right));
        });
        for (const windowRecord of windows.slice(0, MAX_DETAIL_WINDOWS))
            addLine(detailLine(windowRecord, actions.get(windowRecord.key)));
        if (windows.length > MAX_DETAIL_WINDOWS)
            addLine(`${windows.length - MAX_DETAIL_WINDOWS} more windows`);
    }

    _addPartialRestore(item, session) {
        const section = new PopupMenu.PopupMenuSection();
        let shown = false;
        const toggle = new StayOpenMenuItem('Restore part', () => {
            shown = !shown;
            section.removeAll();
            toggle.label.text = shown ? 'Hide restore part' : 'Restore part';
            if (shown)
                this._fillPartial(section, session).catch(() => {});
        });
        item.menu.addMenuItem(toggle);
        item.menu.addMenuItem(section);
    }

    async _fillPartial(section, session) {
        const addLine = (text, callback = null) => {
            const row = callback
                ? new StayOpenMenuItem(text, callback)
                : new PopupMenu.PopupMenuItem(text, { reactive: false });
            row.label.add_style_class_name('workspace-sessions-detail');
            section.addMenuItem(row);
            return row;
        };

        let windows = session.windows;
        const actions = new Map();
        try {
            const preview = await previewMerge(await readSession(session.id), this._desktopSource());
            windows = preview.windows;
            for (const action of preview.plan.actions)
                actions.set(action.savedKey, action);
        } catch {
            windows = session.windows;
        }
        if (!windows.length) {
            addLine('No windows in this session');
            return;
        }
        const placed = windowRecord => actions.get(windowRecord.key)?.type === 'keep';

        const groups = new Map();
        for (const windowRecord of windows) {
            const key = Number.isInteger(windowRecord.workspaceIndex) && !windowRecord.onAllWorkspaces
                ? windowRecord.workspaceIndex
                : 'other';
            if (!groups.has(key))
                groups.set(key, []);
            groups.get(key).push(windowRecord);
        }
        const workspaceKeys = [...groups.keys()].filter(key => key !== 'other').sort((a, b) => a - b);
        for (const index of workspaceKeys) {
            const members = groups.get(index);
            const pending = members.filter(windowRecord => !placed(windowRecord));
            const count = members.length;
            const label = `${workspaceName(session, index)} only · ${count} ${count === 1 ? 'window' : 'windows'}`;
            if (pending.length === 0) {
                addLine(`${label} · already in place`).setSensitive(false);
            } else {
                addLine(label, () => {
                    this._runRestore(session.id, { windowKeys: pending.map(windowRecord => windowRecord.key) });
                });
            }
        }
        if (workspaceKeys.length)
            section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const selected = new Set(windows.filter(windowRecord => !placed(windowRecord)).map(windowRecord => windowRecord.key));
        const ordered = [...windows].sort((left, right) => {
            return (left.workspaceIndex ?? 99) - (right.workspaceIndex ?? 99) ||
                windowLabel(left).localeCompare(windowLabel(right));
        });
        for (const windowRecord of ordered.slice(0, MAX_PARTIAL_WINDOWS)) {
            if (placed(windowRecord)) {
                const row = addLine(partialChoiceLabel(windowRecord, false, true));
                row.setSensitive(false);
                row.label.remove_style_class_name('workspace-sessions-detail');
                continue;
            }
            const row = addLine(partialChoiceLabel(windowRecord, true), () => {
                if (selected.has(windowRecord.key))
                    selected.delete(windowRecord.key);
                else
                    selected.add(windowRecord.key);
                row.label.text = partialChoiceLabel(windowRecord, selected.has(windowRecord.key));
            });
            row.label.remove_style_class_name('workspace-sessions-detail');
        }
        const hiddenPending = ordered.slice(MAX_PARTIAL_WINDOWS).filter(windowRecord => !placed(windowRecord)).length;
        if (hiddenPending > 0)
            addLine(`${hiddenPending} more windows stay selected`);
        const restoreSelected = addLine('Restore selected', () => {
            if (selected.size === 0) {
                notify('Select at least one window.');
                return;
            }
            this._runRestore(session.id, { windowKeys: [...selected] });
        });
        if (selected.size === 0)
            restoreSelected.setSensitive(false);
    }

    _desktopSource() {
        return {
            display: global.display,
            backend: global.backend,
            gnomeShell: this._gnomeShell,
            sessionType: GLib.getenv('XDG_SESSION_TYPE'),
        };
    }

    captureDesktop() {
        return Promise.resolve(captureNow(this._gnomeShell));
    }

    offerCrashRecovery(record, actions, options = {}) {
        this._crashRecovery = {
            savedAt: record.savedAt,
            restore: () => {
                if (this._restoring)
                    return;
                this._recoveryDialog?.close();
                this._crashRecovery = null;
                this._rebuildSoon();
                Promise.resolve(actions.onRestore()).catch(() => {
                    // Restore reports its own errors.
                });
            },
            dismiss: () => {
                this._crashRecovery = null;
                actions.onDismiss();
                this._rebuildSoon();
            },
        };
        this._rebuildSoon();
        if (options.dialog === false)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._crashRecovery)
                this._openRecoveryDialog(record);
            return GLib.SOURCE_REMOVE;
        });
    }

    _openRecoveryDialog(record) {
        if (this._recoveryDialog)
            return;
        try {
            const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });
            this._recoveryDialog = dialog;
            dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
                title: 'Previous desktop was not closed normally',
                description: `A desktop from ${formatLocalTime(record.savedAt)} is saved for recovery. Restoring it puts those windows back. Anything already open stays open.`,
            }));
            dialog.setButtons([
                {
                    label: 'Not now',
                    action: () => dialog.close(),
                    key: Clutter.KEY_Escape,
                    default: true,
                },
                {
                    label: 'Restore',
                    action: () => {
                        dialog.close();
                        this._crashRecovery?.restore();
                    },
                },
            ]);
            dialog.connect('closed', () => {
                if (this._recoveryDialog === dialog)
                    this._recoveryDialog = null;
            });
            dialog.open();
        } catch {
            this._recoveryDialog = null;
        }
    }

    restoreCaptured(session) {
        return this._runRestore(session);
    }

    _showProgress(text) {
        this._progressText = text;
        if (!this.menu)
            return;
        if (!this._progressItem) {
            this._cancelItem = new StayOpenMenuItem('Cancel restore', () => {
                this._restoreJob?.cancel();
            });
            this._progressItem = new PopupMenu.PopupMenuItem(text, { reactive: false });
            this._progressItem.label.add_style_class_name('workspace-sessions-meta');
            this.menu.addMenuItem(this._cancelItem, 0);
            this.menu.addMenuItem(this._progressItem, 1);
            return;
        }
        this._progressItem.label.text = text;
    }

    _clearProgress() {
        this._progressText = '';
        for (const item of [this._progressItem, this._cancelItem]) {
            try {
                item?.destroy();
            } catch {
                // The menu may already have removed the row.
            }
        }
        this._progressItem = null;
        this._cancelItem = null;
    }

    async _runRestore(sessionOrId, selection = null) {
        if (this._restoring)
            return false;
        this._restoring = true;
        this._showProgress('Preparing restore…');
        this._restoreJob?.destroy();
        this._restoreJob = createRestoreJob();
        try {
            const session = typeof sessionOrId === 'string' ? await readSession(sessionOrId) : sessionOrId;
            const chosen = selection ? sessionForSelection(session, selection) : session;
            if (!chosen.windows.length) {
                notify('Nothing selected to restore.');
                return false;
            }
            const results = await mergeRestore(chosen, this._desktopSource(), this._restoreJob, {
                onProgress: text => this._showProgress(text),
            });
            notify(describeResults(results));
            return !results.cancelled;
        } catch (error) {
            notify(`Could not restore the session: ${error.message}`);
            return false;
        } finally {
            this._restoring = false;
            this._restoreJob?.destroy();
            this._restoreJob = null;
            this._clearProgress();
        }
    }

    destroy() {
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = 0;
        }
        this._restoreJob?.destroy();
        this._restoreJob = null;
        this._recoveryDialog?.close();
        this._recoveryDialog = null;
        super.destroy();
    }
});
