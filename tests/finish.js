/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';

export function finish(promise) {
    const loop = GLib.MainLoop.new(null, false);
    let value;
    let failed;
    let settled = false;
    promise.then(result => {
        value = result;
        settled = true;
        loop.quit();
    }, error => {
        failed = error;
        settled = true;
        loop.quit();
    });
    if (!settled)
        loop.run();
    if (failed)
        throw failed;
    return value;
}
