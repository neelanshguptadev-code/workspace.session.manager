# Workspace Sessions — feasibility report

This is the Phase 1 research note from 10 October 2026. The extension has since been built. Install steps, current behavior, and limitations are in the README.

Verified on this machine on 10 October 2026:

- Ubuntu development host, GNOME Shell 50.1 (`gnome-shell` 50.1-0ubuntu1.3)
- Mutter 50.1 (`libmutter-18-0` 50.1-0ubuntu2.4)
- GJS 1.88.0
- Introspection: `Meta-18` at `/usr/lib/x86_64-linux-gnu/mutter-18/Meta-18.typelib`, `Shell-18` at `/usr/lib/gnome-shell/Shell-18.typelib`
- `GioUnix` 2.0 is installed
- Current user settings read from this host: `org.gnome.mutter dynamic-workspaces = true`, `org.gnome.desktop.wm.preferences num-workspaces = 4`, `workspace-names = []`, `experimental-features = ['scale-monitor-framebuffer', 'xwayland-native-scaling']`

Claims below are marked **verified** when they come from that typelib, those schemas, or a local manual page, and **documented** when they come from upstream documentation fetched for this report. Anything else is an **assumption**.

This report is Phase 1. It does not claim the extension has been enabled inside a live Shell session yet.

## Verdict

A GNOME Shell extension can save and later merge a real desktop on Wayland without X11 tools and without another extension. Mutter already exposes windows, workspaces, monitors, frame geometry, and maximized, fullscreen, and minimized state.

It cannot see inside applications. Browser tabs, VS Code projects, file-manager directories, and terminal working directories are not compositor state. Those need optional adapters that use each application's own supported interface. Generic restore must still work when an adapter is missing.

Do not use Wayland session-management as the foundation on this host. Mutter 50.1's `experimental-features` range is only `scale-monitor-framebuffer`, `kms-modifiers`, `autoclose-xwayland`, and `xwayland-native-scaling`. There is no extension-facing API here to snapshot and later reapply an arbitrary named session through `xdg_session_management_v1`. That protocol, where a compositor implements it, lets a client ask the compositor to remember toplevel state for a later launch of that same client. It is not a general "save my desktop under a name and merge it back when I ask" API.

## 1. Which APIs expose windows, workspaces, monitors, geometry, and state?

All of the following symbols were listed from the installed `Meta-18` and `Shell-18` typelibs.

| Need | API | Notes |
| --- | --- | --- |
| All windows | `Meta.Display.list_all_windows()` | Also `window-created` |
| Focus | `Meta.Display.get_focus_window()`, property `focus-window`, signal `focus-window` | |
| Workspace manager | `Meta.Display.get_workspace_manager()` | |
| Active workspace | `WorkspaceManager.get_active_workspace()`, `get_active_workspace_index()`, signal `active-workspace-changed` | |
| Workspace count | `WorkspaceManager.get_n_workspaces()`, `get_workspace_by_index()` | Dynamic mode includes the spare empty workspace |
| Create / remove / reorder | `append_new_workspace()`, `remove_workspace()`, `reorder_workspace()` | |
| Windows on a workspace | `Meta.Workspace.list_windows()`, `index()`, signals `window-added` / `window-removed` | |
| Move a window | `Meta.Window.change_workspace()`, `change_workspace_by_index(index, append)` | `append` can create the destination workspace |
| Move and focus | `activate_with_workspace()`, `Workspace.activate()`, `Workspace.activate_with_focus()` | |
| Frame geometry | `get_frame_rect()` out-parameter, `move_frame()`, `move_resize_frame(user_op, x, y, w, h)` | Coordinates are global, northwest frame edge |
| Monitor index | `Meta.Window.get_monitor()`, `move_to_monitor()` | Wayland monitor changes can complete asynchronously. Shell already has `moveWindowToMonitorAndWorkspace` in `libshell-18.so` because of that. Wait for `Meta.Display::window-entered-monitor` before changing workspace |
| Monitor layout | `Meta.Display.get_n_monitors()`, `get_monitor_geometry()`, `get_monitor_scale()`, `get_primary_monitor()`, `get_current_monitor()` | |
| Monitor identity | `global.backend.get_monitor_manager()` → `Meta.MonitorManager.get_logical_monitors()` / `get_monitors()` | `Meta.LogicalMonitor.get_number()` matches the display index. `Meta.Monitor` has `get_connector()`, `get_vendor()`, `get_product()`, `get_serial()`, `is_primary()`, `is_builtin()` |
| Monitor changes | `Meta.MonitorManager::monitors-changed` | |
| Maximized | `get_maximize_flags()`, properties `maximized-horizontally` / `maximized-vertically`, `maximize()`, `unmaximize()`, `set_maximize_flags()` | Flags: horizontal, vertical, both. No separate tile-mode enum exists in Meta 18 |
| Fullscreen / minimized / above | `is_fullscreen()`, `make_fullscreen()`, `unmake_fullscreen()`, property `minimized`, `minimize()`, `unminimize()`, `is_above()` | |
| Window identity hints | `get_id()`, `get_stable_sequence()`, `get_tag()`, `get_role()`, `get_title()`, `get_wm_class()`, `get_wm_class_instance()`, `get_gtk_application_id()`, `get_sandboxed_app_id()`, `get_pid()`, `get_startup_id()`, `get_client_type()`, `get_window_type()` | See section 2 |
| Application | `Shell.WindowTracker.get_window_app()`, `Shell.App.get_id()`, `get_name()`, `get_windows()`, `get_pids()`, `launch()`, `open_new_window()`, `activate_window()`, signal `windows-changed` | `App.get_id()` is the `.desktop` id |
| App lookup | `Shell.AppSystem.lookup_app()`, `lookup_desktop_wmclass()`, `get_running()` | |
| Launch metadata | `GioUnix.DesktopAppInfo` | `Gio.DesktopAppInfo` still resolves on GNOME 49+ but warns. Use `GioUnix` |

`Meta.Workspace` has no name property. **Verified.**

Workspace labels live in GSettings key `org.gnome.desktop.wm.preferences workspace-names` (**verified** schema text: extra names are ignored; missing names fall back to "Workspace N"). On this host the array is empty. GNOME Shell does not require those labels to be set, and labels written by another extension are just values in that key. This extension may read the key. It must not treat it as Mutter state, and v1 must not write it during restore, because that would change a global user setting.

Dynamic versus static mode is `org.gnome.mutter dynamic-workspaces` (**verified**). Static count is `org.gnome.desktop.wm.preferences num-workspaces`. `org.gnome.mutter workspaces-only-on-primary` changes whether non-primary monitors participate in workspace switching. Capture the boolean with the snapshot.

There is no `Meta.TileMode` in Mutter 18 (**verified**). Edge tiling, when it exists, has to be inferred from horizontal or vertical maximize flags plus geometry. That inference is best-effort. Ubuntu's Tiling Assistant is installed on this host and is out of scope. This extension must not talk to it.

`Meta.Window.get_tag()` is real. Upstream documents it as the Wayland toplevel tag, with an X11 fallback. Record it when an application sets one. Do not expect browsers or VS Code to set one.

## 2. How can application identity and individual windows be matched?

`get_id()` and `get_stable_sequence()` are unique only for the lifetime of that window object inside the current compositor process. They are useful while a restore is in progress. They are not identities to store as durable keys. `get_pid()` changes across restarts and, for multi-window Electron apps, often does not even distinguish windows.

Durable application identity, in order:

1. `Shell.App.get_id()` desktop file id, such as `org.gnome.Nautilus.desktop` or `code.desktop`.
2. `get_gtk_application_id()` for GTK applications.
3. `get_sandboxed_app_id()` for Flatpak and similar sandboxes.
4. `get_wm_class()` plus `get_wm_class_instance()` when no desktop id is available.

Individual windows of the same application need a layered score, not a single key:

1. Integration context, when an adapter captured one (project path, profile plus URL set, directory). This is the only strong distinction between three VS Code windows or three browser windows.
2. `get_tag()` or `get_role()` when the application sets them.
3. Desktop id plus a normalized title.
4. Workspace index and monitor connector, as a weak hint.
5. Geometry and maximize/fullscreen/minimized flags, as a last hint.
6. Order among remaining windows of that desktop id.

A match is accepted only above a threshold. Below that, the planner reports the window as uncertain and does not launch a duplicate on the strength of a title collision. Two windows of one application with different contexts must both survive. Two windows with the same context should collapse to one during merge.

Each saved window gets its own UUID inside the session file. That UUID identifies the saved record. It is not a Mutter id.

## 3. What can be restored generically under Wayland?

Reliable enough to build on, using the APIs above:

- Remember and reapply which workspace a normal window is on, creating missing workspaces with `change_workspace_by_index(..., true)` or `append_new_workspace()`.
- Remember and reapply maximized, fullscreen, and minimized state.
- Remember frame rectangle and monitor, then reapply with `move_to_monitor()` and `move_resize_frame()`.
- Remember the active workspace and, once, the focused window.
- Launch a missing application through `GioUnix.DesktopAppInfo` or `Shell.App.launch()` / `open_new_window()`, then associate the new window via `window-created`, `Shell.App::windows-changed`, and `get_startup_id()` when the client sets one.
- Leave every current window that was not matched untouched. Nothing in this list closes a window. `delete()` and `kill()` exist and must not be used by merge restore.

Best-effort:

- Exact pixel geometry. `move_resize_frame` asks Mutter to configure the window. On Wayland the client can respond with a different size. Apply once. Do not watch `position-changed` and fight the user or the client afterwards.
- Tiled layout. Store maximize flags and the rectangle. Do not claim a tile was restored unless those flags still match after the configure.
- Off-screen avoidance. If the saved connector and serial are gone, place the window on the current primary monitor and clamp it to `get_work_area_for_monitor()`. `user_op = false` keeps the move inside the work area. That is the right flag for restore. `user_op = true` is for imitating a drag and can place a window partly off-screen.
- Stacking order. `raise()` exists, but z-order is not a user-visible promise worth a fight during merge. Skip it in v1.
- Focus. Restoring focus at the end is reasonable. Continuously refocusing is not.

Not available from GNOME:

- Tabs, documents, project folders, terminal cwd, scroll position, unsaved buffers.
- A stable cross-restart window id.
- Names of workspaces, unless the user or another tool has filled `workspace-names`.

`wmctrl` and `xdotool` are X11 tools. They are not part of this design.

## 4. How should non-destructive merging and duplicate prevention work?

A restore builds a plan, shows it, and only then runs it. The plan never contains a close, kill, or "remove windows that are not in the file" action.

For each saved window record:

1. Ask the matching adapter, if any, which current windows already represent that context.
2. Otherwise score current normal windows with the generic layers in section 2.
3. If one current window is a clear match, the action is **reuse**. Later, move it if the workspace or monitor differs. Do not launch.
4. If none match and the record has enough identity to launch safely, the action is **launch**, then wait for a new window and apply placement.
5. If identity is ambiguous, the action is **skip** with a reason. A skip is success-with-uncertainty, not a license to open another copy.
6. Current windows that no saved record claimed are **unrelated**. They stay where they are.

Running the same plan again should find the windows the first run reused or launched, and launch nothing new. That is the idempotency goal.

Cases where a second restore can still duplicate something:

- The application ignores "open this folder" and always creates a window, and the adapter cannot see the context of the existing window.
- Two saved records have no context and identical titles, so the first restore launches both and the second cannot tell which is which.
- The user closed the restored window and wants it back. That second launch is intentional, not a duplicate of a live window.

Cancellation stops further launches and further moves. It does not close windows already touched.

User intervention: after a placement is applied, drop that window from the restore set. A later `position-changed` or `workspace-changed` caused by the user is not a reason to move it back.

Replace mode is not part of v1. If it is ever added, it is a separate command with an explicit confirm step that lists every window it would close.

Automatic restore on login or on `enable()` is forbidden. `enable()` only creates the indicator.

## 5. How should dynamic/static workspaces and changed monitors be handled?

Capture:

- `dynamic-workspaces`, `workspaces-only-on-primary`, and `num-workspaces`.
- `get_n_workspaces()` and each workspace index.
- The gsettings label array, which may be empty. Do not invent names from the current desktop.
- For each window, workspace index, `is_on_all_workspaces()`, monitor index, connector, and serial.
- For each logical monitor, index, geometry, scale, connector, vendor, product, serial, primary, builtin.

On restore:

- Match monitors by serial, then connector, then geometry. Indexes are a fallback because they change when a display is plugged in.
- If dynamic workspaces are on, do not try to recreate a specific count of empty workspaces. Place windows onto the indexes they need and let Mutter keep its spare empty workspace. The saved count included that spare and will not match one-for-one after a merge into a busier desktop.
- If dynamic workspaces are off, raise `num-workspaces` only when a saved window index does not fit. Do not lower it. Lowering would drop workspaces the user currently has.
- If the saved session was dynamic and the current session is static, or the reverse, still place windows by index and report the mode mismatch. Do not flip `dynamic-workspaces`. That setting is global and not part of a named session.
- `workspaces-only-on-primary` is the same kind of global mode. Record it. Do not change it in v1. If it differs from the snapshot, placement onto a non-primary monitor is best-effort and must be reported.

A missing monitor never leaves a window at saved coordinates that are now off-screen. Clamp to an available work area.

## 6. What can restore browser profiles, windows, tabs, and URLs?

GNOME cannot read tabs. **Assumption confirmed by absence:** `Meta.Window` has title, class, gtk id, and tag, and no URL or tab list.

Documented mechanisms, per browser family, not per brand. The adapter selects an implementation from the desktop id. Brave on this host is a Chromium-family snap (`/snap/bin/brave`). Firefox is `/usr/bin/firefox`. No browser is required for the extension to load.

Chromium family (Chrome, Chromium, Brave, Edge, Vivaldi, and other Chromium desktop files):

- Documented launch: a new window with an explicit URL list, plus `--profile-directory` when the profile directory name was captured. That restores "this profile, these sites, on this workspace" for a window we ourselves open.
- `--restore-last-session` restores whatever the browser last wrote, not a named Workspace Sessions snapshot, and not a chosen subset of windows. It is the wrong tool for several named sessions.
- Reading `Current Session` / `Last Session` files parses a private, version-locked format while the browser may be writing it. Do not do that.
- `--remote-debugging-port` exposes browser control beyond tab URLs. Do not enable it for session restore.
- A reliable capture of which live window contains which tabs needs an optional WebExtension using `tabs` and `windows`, talking to a local native-messaging host. The host stores window identity, profile id, and ordered tab URLs. It does not read the cookie, login, or history databases.

Firefox family:

- Documented flags include `--new-window URL`, `--new-tab URL`, `-P profile-name`, and `--profile path` (Mozilla command-line documentation).
- `--restore-last-session` has the same limitation as Chromium: it is the browser's own last session, not our named snapshot.
- `sessionstore.jsonlz4` is an internal file. Do not parse it.
- The same optional WebExtension shape works against the Firefox extension API. One native host protocol, two extension packages. The GNOME extension does not embed either browser.

Without the optional extension, Phase 5 can still launch a missing window with the URLs that were known at save time. It cannot discover those URLs in the first place unless they were typed by the user or the title happens to contain one. So the honest v1 browser behavior is generic window placement. URL capture waits for the optional integration.

Matching a browser window without the integration is weak: every window shares a desktop id, and the title is usually only the active tab. The planner must not treat "a Firefox window exists" as a match for a specific saved Firefox window if more than one exists or a context was saved. It should reuse a single existing window only when the saved record also has no finer context and only one candidate exists. Otherwise it launches or skips, and says which.

Never store passwords, cookies, tokens, or profile directories' secret files. A profile *name* or Chromium profile-directory key such as `Default` or `Profile 1` is not a secret. The profile path may be stored only as the argument Firefox's `--profile` already requires, and only if the user turns that adapter on.

## 7. How can VS Code projects be captured and reopened?

Official CLI documentation (code.visualstudio.com, fetched for this report) supports:

- `code <folder>` and `code <file>` to open a folder or file. Several folders become a multi-root workspace.
- `code <path>.code-workspace` for a workspace file.
- `--new-window` to open a new session instead of restoring the previous one.
- `--reuse-window` to force the last active window.
- `--profile <name>` to choose a VS Code profile.
- `vscode://file/{path}` as a URL form of the same open action.

On this host the executable is `/snap/bin/code`. The desktop id must be discovered from `Shell.App`, not hardcoded. Insiders would be `code-insiders` and is a separate desktop id if present.

What the CLI does **not** provide: a query of "which GNOME window has which folder". Electron windows share one process and one app id. `get_pid()` will not separate them.

Capture strategy, in order:

1. Optional VS Code extension, later, that writes only workspace-folder URIs and workspace-file URIs for each of its windows. Still no editor buffers.
2. Best-effort parse of the default window title. VS Code's default title includes the root folder name. This fails when `window.title` is customized, when two projects share a basename, or when the title is a dirty file name. Mark confidence `title-basename`, not `verified-path`.
3. If neither source produces a path, store a generic VS Code window with `context: null`.

Restore strategy:

- If a current window already matched that folder or workspace file, reuse it.
- Otherwise launch an argv the adapter builds itself: the resolved `code` binary, optional `--profile`, optional `--new-window`, and the folder or `.code-workspace` path as a single argument. Never a shell string from the session file.
- Use `--new-window` when other VS Code windows are already open and none of them matched this project, so the launch does not replace the folder in an unrelated window. The user's `window.openFoldersInNewWindow` setting can still change VS Code's behavior. The adapter must watch which window actually appears or comes forward and associate that one. If the wrong window's title changes to this project, report a conflict instead of opening yet another copy.
- Do not pass `--reuse-window` during multi-project restore. It targets the last active window and would mix projects.

Not recoverable with the CLI: unsaved editor buffers, the integrated terminal's cwd and scrollback, debug sessions, the exact editor layout, and which file was focused. Say so in the preview.

Other IDEs (JetBrains, GNOME Builder, Cursor) fit the same adapter interface later. They are not in the first implementation. Cursor in particular must not be special-cased just because this report was written in it.

## 8. What might work for file managers, terminals, and other applications?

File managers:

- `org.freedesktop.FileManager1.ShowFolders` is the published interface (freedesktop specification). Nautilus implements it. Restore a directory by calling `ShowFolders` with a `file://` URI, or by launching the desktop file with that URI through `GioUnix.DesktopAppInfo`.
- Capture of the open directory is not a Mutter property. Nautilus window titles are often the folder name, which is ambiguous (`Documents` in two places). A correct adapter needs a supported Nautilus API or a title plus a unique path from somewhere else. Until that exists, save the generic window and mark directory context unsupported. Do not scrape Nautilus internals.

Terminals, verified locally:

- Ptyxis is installed. Its manual page documents `--new-window` together with `-d, --working-directory`, plus `--title`, `--tab`, and `--tab-with-profile`. Restore can open a new window in a directory. Capture of the live cwd is not provided by that manual page. Reading `/proc/<pid>/cwd` is a fallback only when the window's pid is actually the shell, which often it is not (the terminal process is the parent). Mark cwd capture best-effort and off unless the mapping is unambiguous.
- GNOME Console (`kgx`) and GNOME Terminal are not installed here. Their adapters should be added from their own `--help` when a desktop file for them appears, not hardcoded now.
- Do not restore a terminal by replaying a command from the session file. A working directory is a launch argument the adapter chooses. An arbitrary command is code execution and is out of scope.

Documents:

- Apps that accept a file URI on the command line or via `Gio.AppInfo.launch_uris` (Evince, LibreOffice, Papers, Text Editor) can be opened on a path when an adapter recorded one.
- Paths will not be known unless the title contains a filename or the app exposes a document URI. Generic restore still places the existing window.

GTK applications that set `get_gtk_application_id()` are the best generic matches. Electron applications are the worst. The architecture is the same either way: adapter or generic placement.

## 9. Which features are reliable, best-effort, or unsupported?

| Feature | Level |
| --- | --- |
| List normal windows, desktop id, title, workspace, monitor, frame, maximize, fullscreen, minimized | Reliable to capture. Verified APIs |
| Move an existing window to a workspace, including creating that workspace | Reliable, with the Wayland monitor-then-workspace ordering |
| Maximize, unmaximize, fullscreen, minimize | Reliable as requests. The client can still refuse |
| Pixel position and size | Best-effort on Wayland |
| Tiling | Best-effort via maximize flags only |
| Active workspace and focused window | Reliable to capture. Apply once at the end of restore |
| Workspace names | Unsupported as Mutter state. Optional gsettings labels, currently empty on this host |
| Stable window id across logout | Unsupported |
| Browser tabs and profile-to-window mapping | Unsupported without an optional extension. Launch-with-URLs is reliable only after those URLs were captured |
| Browser native session restore as a substitute for a named session | Unsupported for this product's guarantee |
| VS Code folder or `.code-workspace` in a new window | Reliable to launch once the path is known. Discovering the path from GNOME is best-effort |
| VS Code unsaved editors, terminal, debug, layout | Unsupported |
| Nautilus directory | Restore is supported if the URI is known. Capture is best-effort at best |
| Ptyxis working directory | Restore is supported via the documented flag. Capture is best-effort |
| Replaying shell commands, closing unrelated apps, login auto-restore | Will not be implemented in the default mode |

## 10. Integration interface and session schema

Adapters are plain modules the core calls. The core does not import browser or editor specifics.

Each adapter may implement:

- `matches(app)` — true when this adapter owns that desktop id.
- `capture(window, app)` — returns a JSON-safe context or `null`.
- `findMatch(savedWindow, currentWindows)` — returns a current window or `null`, plus a confidence.
- `launch(savedWindow)` — starts the missing context using a fixed argv or a D-Bus method the adapter contains, not a string stored in the session.
- `describeUnsupported()` — short list for the preview.

No adapter means generic matching and `Shell.App` launch with no extra arguments.

Session file:

- Format id `workspace-sessions`, `formatVersion` 1.
- Human-readable JSON.
- Directory `XDG_DATA_HOME/workspace-sessions/sessions/<uuid>.json`, mode `0700` / `0600`.
- Write to a temporary file in the same directory, then rename over the destination.
- Reject files larger than 2 MB, non-JSON, unknown `formatVersion` (until a migration exists), path-like ids, and any object key named `command`, `exec`, `shell`, `argv`, `script`, `cookies`, `password`, `token`, `secret`, `credentials`, or `history`.
- The file describes state. Restore code may read known fields for a known provider. It must not pass a file string to a shell.

Stored on purpose: session name and timestamps, GNOME version and session type, workspace mode flags, workspace count, gsettings labels, monitor geometry and identity, per normal window the desktop id and fallback identity fields, title, workspace, monitor, frame, window state, optional tag and role, and optional adapter context.

Not stored: Mutter window id, pid, GTK bus name, cookies, tokens, command lines.

Titles, paths, and URLs are sensitive. A later preference can omit titles. The schema allows `context` to be null so generic snapshots stay valid.

## 11. Risks

| Risk | Why it matters | Response |
| --- | --- | --- |
| Wayland configure is a request | Size and position can be ignored or adjusted | Apply once, report what stuck, never loop |
| Monitor move is asynchronous | Workspace change can be dropped if it races the monitor change | Move monitor first, wait for `window-entered-monitor` |
| Dynamic workspace spare | Saved count is not the user's mental count | Store the count, restore by window index, do not delete empty workspaces |
| Desktop id missing | Some XWayland or small tools have only a class | Match on class, low confidence, prefer skip over duplicate launch |
| Electron multi-window | PID and app id do not separate contexts | Adapter required for a strong match |
| Reading browser session files | Private format, races the browser, easy to over-collect | Forbidden |
| Remote debugging | Too much control | Forbidden |
| Session file as a script | A renamed session could smuggle a command | Schema reject list, argv built only inside adapters |
| `Gio.DesktopAppInfo` deprecation | GNOME 49+ warns | Call `GioUnix.DesktopAppInfo` |
| Shell API drift | 45 through 49 were not run here | `shell-version` stays `50` until another version is actually enabled |
| Workspace-only-on-primary and scaling changes | Placement math changes | Record the modes, clamp to the live work area |
| Accidental close | Merge must not call `delete` or `kill` | Those code paths do not exist in the restore plan |
| Extension left connected | Signals after disable crash the Shell | Disconnect and destroy the indicator in `disable()` |
| Tiling Assistant on this Ubuntu host | Could look like a dependency | Ignore it |

## 12. Smallest useful first implementation

Phase 2, which starts after this report:

- Extension loads on Shell 50, does nothing on enable except add a panel control.
- On request, inspect the live desktop and write a version-1 JSON session.
- List, rename, duplicate, update, and delete those files.
- Validate before writing and after reading.
- Do not launch, move, or close anything.

Phase 3 is reuse-only restore: match windows that are already open and move them, still without launching. Phase 4 adds launches. Phase 5 adds the VS Code CLI adapter and a browser adapter that can open URLs once they have been captured, plus the optional WebExtension design if URL capture is still blind. Phase 6 is preview, progress, and cancellation. Phase 7 is packaging.

The first implementation is useful because it proves capture against a real Wayland session and locks the file format before any code is allowed to change the desktop.

Phase 2 code is in `extension/`. It saves, updates, renames, duplicates, and deletes session files. It does not restore. `gjs -m tests/test-model.js` covers the schema and the atomic store. The extension has not been enabled inside the running Shell yet: on Wayland the Shell only scans new extensions at login.

## Recommended plan

1. Phase 2 now: inspector, schema, atomic storage, panel menu to save and manage files.
2. Enable it on this Shell 50.1 session and save a live desktop. That is the first runtime test. Until it happens, compatibility is "developed against 50.1", not "tested on 50.1".
3. Phase 3: pure matching function with tests, then a preview and a merge that only calls workspace and geometry APIs on matched windows.
4. Phase 4: launch missing apps by desktop id, associate new windows by signal, timeout per app, continue after a failure.
5. Phase 5: VS Code adapter from the documented CLI, then one Chromium-family and one Firefox-family launch path. Optional native-messaging capture is a separate, default-off component.
6. Keep `shell-version` at 50 until the same scenarios are run on another GNOME release.
