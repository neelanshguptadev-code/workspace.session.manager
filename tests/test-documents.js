/* Workspace Sessions
 * Copyright (C) 2026 Neelansh Gupta <workspace.session.manager@gmail.com>
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import System from 'system';

import { planMerge } from '../extension/core/matching.js';
import { finish } from './finish.js';
import {
    documentForTitle,
    documentKind,
    documentStem,
    documentTitleMatches,
    enrichDocumentContexts,
    flagsForDocument,
    parseRecentDocuments,
    planDocumentLaunch,
} from '../extension/integrations/documents.js';

const failures = [];

function assert(condition, message) {
    if (!condition)
        failures.push(message);
}

const recent = parseRecentDocuments(`
<bookmark href="file:///home/user/Documents/notes.odt">
  <mime:mime-type type="application/vnd.oasis.opendocument.text"/>
</bookmark>
<bookmark href="file:///home/user/Documents/photos">
  <mime:mime-type type="inode/directory"/>
</bookmark>
<bookmark href="file:///home/user/Documents/Report.odt">
  <mime:mime-type type="application/vnd.oasis.opendocument.text"/>
</bookmark>
<bookmark href="file:///tmp/other/Report.pdf">
  <mime:mime-type type="application/pdf"/>
</bookmark>
<bookmark href="file:///home/user/notes.txt">
  <mime:mime-type type="text/plain"/>
</bookmark>
`);
assert(recent.length === 4, 'directories in recent files are not documents');
assert(documentStem('notes.odt — LibreOffice Writer').name === 'notes.odt', 'a writer title keeps the file name');
assert(documentStem('notes.txt (/home/user) - gedit').directory === '/home/user', 'a gedit title keeps the directory');
assert(documentForTitle('notes.odt — LibreOffice Writer', recent) === '/home/user/Documents/notes.odt', 'a unique document title selects that file');
assert(documentForTitle('Report', recent) === null, 'two files with the same name are not guessed');
assert(documentForTitle('Report.odt - LibreOffice Writer', recent) === '/home/user/Documents/Report.odt', 'an extension picks one of two similar names');
assert(documentForTitle('notes.txt (/home/user) - gedit', recent) === '/home/user/notes.txt', 'a title with a directory opens that file');
assert(documentForTitle('notes.txt (/tmp/../etc) - gedit', []) === null, 'a parent directory is not opened');
assert(documentTitleMatches('Budget — LibreOffice Calc', { path: '/home/user/Budget.ods' }), 'a calc window matches its file');

assert(documentKind('libreoffice-writer.desktop', 'libreoffice-writer') === 'libreoffice', 'Writer is a document app');
assert(documentKind('org.gnome.TextEditor.desktop', null) === 'text-editor', 'Text Editor is a document app');
assert(documentKind('org.gnome.Papers.desktop', 'papers') === 'papers', 'Papers is a document app');
assert(documentKind('org.gnome.Nautilus.desktop', 'nautilus') === null, 'Files stays a folder window');
assert(flagsForDocument('text-editor', 'gnome-text-editor %U').join(' ') === '--new-window', 'Text Editor opens a new window');
assert(flagsForDocument('libreoffice', 'libreoffice --writer %U').join(' ') === '--writer --norestore', 'Writer opens its file without LibreOffice crash recovery');

const writer = planDocumentLaunch('/usr/bin/libreoffice', ['--writer', '--execute'], { path: '/home/user/Documents/notes.odt' });
assert(writer?.argv?.join('\n') === '/usr/bin/libreoffice\n--writer\n/home/user/Documents/notes.odt', 'the file is one launch argument');
assert(planDocumentLaunch('/usr/bin/gnome-text-editor', ['--new-window'], { path: '/tmp/../etc/passwd' }) === null, 'a parent path is not opened');

const enriched = finish(enrichDocumentContexts([
    {
        title: 'notes.odt — LibreOffice Writer',
        context: null,
        app: { desktopId: 'libreoffice-writer.desktop', wmClass: 'libreoffice-writer' },
    },
    {
        title: 'Home',
        context: null,
        app: { desktopId: 'org.gnome.Nautilus.desktop', wmClass: 'nautilus' },
    },
], recent));
assert(enriched[0].context?.data.path === '/home/user/Documents/notes.odt', 'a writer window stores its file');
assert(enriched[1].context === null, 'a file window is left for the folder adapter');

const plan = planMerge({
    focusedWindowKey: null,
    environment: { dynamicWorkspaces: true },
    windows: [{
        key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        app: {
            desktopId: 'org.gnome.TextEditor.desktop',
            name: 'Text Editor',
            gtkApplicationId: null,
            sandboxedAppId: null,
            wmClass: 'org.gnome.TextEditor',
            wmClassInstance: 'org.gnome.TextEditor',
        },
        title: 'notes.txt',
        windowType: 'normal',
        clientType: 'wayland',
        workspaceIndex: 1,
        onAllWorkspaces: false,
        monitorIndex: 0,
        monitorConnector: 'eDP-1',
        monitorSerial: 'ABC',
        frame: null,
        state: {
            maximizedHorizontally: false,
            maximizedVertically: false,
            fullscreen: false,
            minimized: false,
            above: false,
        },
        role: null,
        tag: null,
        context: { provider: 'document', data: { path: '/home/user/notes.txt' } },
    }],
}, [], [{
    index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    connector: 'eDP-1', serial: 'ABC', primary: true, builtin: true,
}]);
assert(plan.actions[0]?.type === 'launch', 'a closed document is opened');
assert(plan.actions[0]?.context?.data.path === '/home/user/notes.txt', 'the launch keeps the file');
assert(plan.actions[0]?.reason?.includes('saved file'), 'the plan says the file will open');

if (failures.length > 0) {
    for (const failure of failures)
        printerr(failure);
    System.exit(1);
}
print('document tests passed');
