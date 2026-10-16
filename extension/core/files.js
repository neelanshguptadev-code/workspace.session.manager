/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export function readFileContents(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok)
                    throw new Error('Could not read the file');
                resolve(contents instanceof Uint8Array ? contents : new Uint8Array(contents));
            } catch (error) {
                reject(error);
            }
        });
    });
}
