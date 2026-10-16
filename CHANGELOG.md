# Changelog

## 18 — 2026-10-16

- In Restore part, windows already in place are shown grey and cannot be restored again.

## 17 — 2026-10-16

- Never block the GNOME Shell lock or shutdown path while finalizing crash recovery.

## 16 — 2026-10-16

- Wait for the current desktop to finish loading before an update is saved.

## 15 — 2026-10-16

- Read session files without blocking the Shell, and stop declaring the default user session mode.

## 14 — 2026-10-15

- Restoring a file-manager folder opens that folder when Files is already showing a different one. The other window stays open.

## 13 — 2026-10-15

First packaged release, for GNOME Shell 50.

- Save, rename, duplicate, and delete named sessions. Delete asks for a second click and keeps the menu open.
- Update a session from the current desktop, and undo that update once. The session name stays the same.
- Warn when a new save matches a session that is already stored.
- Show the last update time and a Details view of what the session contains.
- Restore by merging. Matching windows move. Missing windows open. Unrelated windows stay open.
- Restore one workspace, or a chosen set of windows.
- Show progress during restore, and cancel from the same menu.
- Reopen Chromium-family profiles and tabs, Firefox tabs, editor folders, file-manager folders, Ptyxis directories, and supported documents.
- Keep one recovery snapshot after the desktop has been still for a minute. Offer it on the next login only when the previous Shell did not close cleanly. Logging in does not restore a session by itself.
