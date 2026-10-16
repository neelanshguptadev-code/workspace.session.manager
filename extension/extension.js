/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { recoverySession } from './core/recovery.js';
import { readRecovery, writeRecovery } from './core/storage.js';
import { startRecoveryWatch } from './gnome/recovery.js';
import { SessionIndicator } from './ui/indicator.js';

export default class WorkspaceSessionsExtension extends Extension {
    enable() {
        this._indicator = new SessionIndicator(Config.PACKAGE_VERSION, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._watcher = startRecoveryWatch(() => this._indicator.captureDesktop());
        this._offerRecovery();
    }

    _offerRecovery() {
        readRecovery().then(crash => {
            if (!crash || crash.clean || !crash.captured?.windows?.length)
                return;
            this._watcher?.hold();
            this._indicator.offerCrashRecovery(crash, this._recoveryActions(crash));
        }).catch(() => {
            // A missing recovery file means there is nothing to offer.
        });
    }

    _recoveryActions(crash) {
        return {
            onRestore: () => this._acceptRecovery(crash),
            onDismiss: () => this._discardRecovery(crash),
        };
    }

    async _acceptRecovery(crash) {
        const restored = await this._indicator.restoreCaptured(recoverySession(crash));
        if (!restored) {
            this._indicator.offerCrashRecovery(crash, this._recoveryActions(crash), { dialog: false });
            return;
        }
        try {
            writeRecovery({ ...crash, clean: true });
        } catch {
            // A later quiet snapshot can replace this file.
        }
        this._watcher?.release();
    }

    _discardRecovery(crash) {
        try {
            writeRecovery({ ...crash, clean: true });
        } catch {
            // The menu entry is already gone. The next clean shutdown rewrites the file.
        }
        this._watcher?.release();
    }

    disable() {
        this._watcher?.flushClean();
        this._watcher?.destroy();
        this._watcher = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
