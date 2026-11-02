# Linux Troubleshooting

Start with `agent-desktop status` and `agent-desktop list-apps`.

## Symptom to cause

| Symptom | Cause and action |
|---------|------------------|
| `PLATFORM_NOT_SUPPORTED` "The AT-SPI accessibility bus is not available in this session", or `status` shows empty `supported_surfaces` | Session bus or accessibility bus unreachable: the bus did not answer. Read `references/bus-and-permissions.md`; run inside the desktop session |
| `list-apps` empty, `status` healthy | Bus up, no app registered. Start an app, or restart one that started before the bus |
| App runs, `--app` finds nothing | Not on the bus, or wrong name. Use the `list-apps` name; see "Apps that are not on the bus" |
| Chromium shows a bus entry but no windows | Renderer accessibility is off. Add `--force-renderer-accessibility` |
| Window appears, `snapshot` is thin | Content not ready. `wait --window`, then `wait --text`; raise the wait's `--timeout` or the snapshot's `--timeout-ms` |
| `TIMEOUT` on `snapshot` | No usable observation before the deadline, or an incomplete `--root` drill-down. Raise `--timeout-ms`; see "Observation details" |
| `ACTION_FAILED` `activation_not_granted` | The window manager never activated the window: `references/windows-and-lifecycle.md`, Focus |
| `ACTION_FAILED` `overview_open` | GNOME Activities Overview is open. `focus-window` refuses with it, and a `click` or `expand` on a menu opener that showed no popup (`details.kind: popup_not_observed`) names it while it is open. Close it and retry |
| `ACTION_FAILED` `frame_not_active` or `check: window_active` | The window manager made the window active but the app does not report it. Run `snapshot` on the app once and retry (intermittent on Electron) |
| `ACTION_FAILED` `grab_focus_rejected` on `focus @ref` | The toolkit rejected `Component.GrabFocus` (GTK4 does) and nothing moved. Focus the window with `focus-window`; `type` and `press` need the target focused, see `references/display-servers-and-input.md` |
| `POLICY_DENIED` on `click` or `type` | A required policy or capability is absent. Read the failed check. Headed policy gives physical input only where the receiver can be proven |
| Tray item lists no `Activate` or `ContextMenu` | No primary protocol action. Use an advertised virtual menu entry. Headed input does not prove a native receiver from the item's title |
| `POLICY_DENIED` on `press` | Blocked combo. Do not use `--force` unless you mean it |
| `ACTION_NOT_SUPPORTED` `wayland_session` | Wayland focus, headed scoped `press` or control of native Wayland windows is unavailable. Bring the target forward yourself; use global `press` or the app's own UI |
| `ACTION_NOT_SUPPORTED` with `physical_delivery_started: false` | Ordinary app pointer input on Wayland. Use a semantic action, `set-value` or a global `press` |
| `PLATFORM_NOT_SUPPORTED`, `daemon: absent` or `unsupported` | Notification protocol missing, or its owner is not the detected shell backend. Run inside the supported desktop session; see the shell reference |
| `PLATFORM_NOT_SUPPORTED`, `watcher: absent` | No SNI watcher exists. Start the session's tray backend providing `org.kde.StatusNotifierWatcher`; extension advice requires a detected backend |
| `ACTION_NOT_SUPPORTED`, `shell_container_unproven` | Roles and parent chains do not establish the shell container or opener. Use an app surface or the logical SNI tray. English labels, wrapper depth and screen position cannot establish popup identity |
| `ACTION_NOT_SUPPORTED`, `native_window_unproven` | The display server did not answer the native window read while the listing ran. `launch` reads again until its timeout before it answers this. Run `list-windows` again once the display has settled. A window of another process whose native surfaces cannot be classified stays listed and never refuses the listing |
| `STALE_REF` with `kind: resolution_identity_unknown`, or a click timeout with that `last_report` | Strict resolution could not prove a menu ref's live identity. Do not infer a hung app from a readable menu; see the shell reference |
| `APP_UNRESPONSIVE` | The app is stopped (`SIGSTOP`) or its main loop is blocked. Resume it; `close-app --force` ends it |
| `STALE_REF` | The UI changed or the window closed. See `details.kind`: `resolve_no_candidate` means no live element matched and is retryable (an action waits its budget before it reports it); `resolve_target_destroyed` needs a replacement target; `menu_closed` needs its opener reopened before a fresh menu snapshot. The last two forbid retrying the old ref |
| `ACTION_NOT_SUPPORTED`, `selection_index_unproven` | The toolkit's selection indices cannot identify accessible rows safely. A headless select cannot map the row and refreshing cannot help. On X11 run `--headed select` with the same ref; see "Toolkit limits" |
| `INTERNAL` "private file parent is accessible by group or other users" | The state root is group-writable or world-accessible. `chmod 700` it; see `references/bus-and-permissions.md` |

## Apps that are not on the bus

An app is in `list-apps` only when its toolkit registered with the accessibility
bus. The CLI says so when a process is running but not on the bus.

| App | Needs |
|-----|-------|
| GTK3, GTK4 | Registers by default when `toolkit-accessibility` is on or the bus exists. An app that started before the bus never registers: restart it |
| Qt | `QT_ACCESSIBILITY=1` in the process environment |
| Chromium browsers (Chrome, Chromium) | `--force-renderer-accessibility` on the command line. `ACCESSIBILITY_ENABLED=1` alone puts the browser on the bus with no windows |
| Electron | No accessibility flag. `--no-sandbox` where `chrome-sandbox` is not setuid |
| Flatpak, snap | The sandbox must share the bus: `references/shell-tray-and-notifications.md` |

Pass launch flags through `launch`:

```bash
agent-desktop launch google-chrome --arg=--force-renderer-accessibility
```

In a session with no desktop settings daemon (container, CI, bare Xvfb)
`org.a11y.Status IsEnabled` is false, so pass `launch --env ACCESSIBILITY_ENABLED=1`
as well, or the browser never joins the bus and `launch` waits its full timeout.

Chrome lists as `chrome`: use `--app chrome` afterwards. The `launch` result
carries `renderer: chromium`. Chromium and Electron read thin until they settle:
pass `--timeout-ms` to `snapshot` rather than concluding the tree is empty. A
Chromium menu frame is a nameless top-level frame, not a window, so it does not
count as a window event.
Electron limit: when the command is the only AT-SPI client, its disconnect can
crash the Electron accessibility bridge (VS Code exits with SIGSEGV on `press`).
A GNOME desktop keeps the shell connected, so this does not occur there. Electron native dialogs
(save prompt, drop confirmation) are not on the AT-SPI tree: `close-app` counts
them, but no read command sees them. Tree items that report `expandable` have no
expand action, and menu items cannot be clicked by ref: use `--headed` pointer
input on their bounds.

## Observation details

- Check `data.complete` before you treat a missing control as absent (see the
  core `commands-observation` reference on partial trees).
- `--root @ref` takes the window and options from the ref's snapshot.
- `status` shows the snapshot the latest `find` wrote.
- `find --first` returns `data.match`, not `data.matches`.
- `find --text` matches a subtree's text, so ancestors of the text match too.
  `wait --text` matches a node's own name, value or description.
- A cell inside a cell (in a list row) is two refs.
- A node without a usable position has no `bounds` and is not hit-tested.
- A password field is withheld only where the toolkit reports a password role. A
  GTK4 `Gtk.Entry` with visibility off, an entry with `InputPurpose.PASSWORD` and
  `Adw.PasswordEntryRow` all show their text: observation commands read them.
- A `scrollarea` with no ref cannot take `scroll @ref`.
- Live `offscreen` comes from positive evidence: a minimized window, a
  scrolled-out GTK3 sentinel row, or a rectangle outside its frame, scroll
  container or every display. `VISIBLE` without `SHOWING` alone proves neither
  hidden nor offscreen. A proven intersection in a non-minimized window can
  report false; missing placement evidence stays unknown. Snapshots carry
  neither live `offscreen` nor `hidden`. `offscreen` is not a supported
  `get`/`is` property: use the live evidence in an actionability refusal.

## GTK editor tabs

GNOME Text Editor can expose the focused document's editor under both tab
groups: `alpha.txt` and `beta.txt` can both contain `BETA FILE` with focused and
visible state. Native AT-SPI exposes the same duplication. A group label can
name one file while its child editor exposes another file's content, so the
label and the child's focused state do not prove which buffer a ref will edit.

Switch to the intended tab, take a fresh snapshot and verify the active content
before editing. For example, with `beta.txt` active and `alpha.txt` immediately
to its left in the focused Text Editor window, and known distinct contents
`BETA FILE` and `ALPHA FILE`:

```bash
agent-desktop press ctrl+pageup --app gnome-text-editor
agent-desktop snapshot --app gnome-text-editor -i --compact
agent-desktop press ctrl+a --app gnome-text-editor
agent-desktop press ctrl+c --app gnome-text-editor
agent-desktop clipboard-get
```

Check that the copied text is `ALPHA FILE`. This replaces the clipboard and
selects the buffer. Use Ctrl+PageDown to switch right. If the identity is still
unclear, stop before writing. For separate targets, open each document in its
own window (`agent-desktop launch gnome-text-editor --arg=--new-window --arg=/tmp/note.txt`)
and use `--window-id` with fresh snapshots. If Text Editor already has the file
open, that launch opens an empty `New Document (Draft)` window and shows the
file as a tab in its existing window, so run `list-windows` to see which window
shows it.

## Toolkit limits

| Toolkit | Limit |
|---------|-------|
| GTK4 | Bounds are the window-coordinate rectangle translated to the window's X11 client origin: the unique client of its process and title, or, for two windows that share a title, the client the window manager reports active for the window the toolkit reports active and the other client for the other window. The window itself, in `list-windows` and as the root of a snapshot, is the rectangle that client draws without its shadow. Elsewhere no position is reported: a headless semantic action still acts in its own window, and a request that needs a pointer position answers `AMBIGUOUS_TARGET` with `details.kind: window_position_ambiguous`. The toolkit's `[0,0,w,h]` screen extents establish no position. Menu item labels come from the labelling node. Secret entries show text |
| GTK3 | `scroll-to` works through the scrollbar. A held handle answers stale values for 16 to 17 s after its object is destroyed, so waits re-resolve on every poll |
| Qt | `scroll-to` does not work: use `scroll --headed`. A `QLineEdit` context menu is not observable. The combo popup takes no semantic selection. A Qt process registers twice; the apps list shows one entry per process |
| Chromium, Electron | `scroll-to` works through `ScrollTo`. `hit_test` answers unknown for an Electron host. Chromium needs the flag above; Electron needs none |

GNOME Settings category rows expose no semantic activation action, and the list
has hidden rows its accessible indices cannot see, so a headless `select` on
`Settings categories` refuses without changing the selection. On X11,
`--headed select` clicks the matched row and answers `delivered_verified` when
the row reads selected; `details.semantic_refusal` records the refusal. Verify
the pane too. Do not retry a headless `select` with refreshed refs.

A search control may expose no semantic SetValue action, and ref-addressed
headed typing can refuse `target_focus`. Open search through a fresh observed
control or an app-documented shortcut, then take a fresh snapshot. Identify the
intended editor by role, editable capability and live focused state; a
translated label is not a readiness condition. If the toolkit omits the editor
or focus cannot be proven, stop before typing or pasting. Once focus is
independently established, a clipboard paste replaces the clipboard: verify the
resulting query and results. A paste report alone does not prove the field
received it.

`hit_test` answers `Unknown` on Wayland, with no window manager, for GTK4 where
the X11 mapping stays ambiguous, and for an Electron host. Ref-addressed
physical clicks and wheels refuse unproven hit results with `ACTION_FAILED`,
`details.kind: pointer_hit_unproven`. A covered button is still `visible` and
headless-actionable: occlusion is checked only before pointer delivery.

Same-window sibling overlap refuses physical input with `ACTION_FAILED`,
`details.kind: hit_test_unproven`, `reason: sibling_overlap` and
`physical_delivery_started: false`. GTK3 and Qt can name an underlying child in
their native point queries, but their child order, component layer and z-order
do not establish which overlapping sibling receives input. The same conservative
check applies to GTK4. Remove the overlap, then take a fresh snapshot before
retrying. The check follows live child lists; GTK4's `Parent` property can
disagree with them. Missing child bounds or an unreadable branch also refuse as
unproven. A snapshot alone cannot repair overlapping widgets.

## Errors and `platform_detail`

Errors keep the standard envelope. Linux fills `platform_detail` with the raw
D-Bus or X11 error.

| `error.code` | Typical `platform_detail` | Meaning |
|--------------|---------------------------|---------|
| `PLATFORM_NOT_SUPPORTED` | `org.freedesktop.DBus.Error.ServiceUnknown` | AT-SPI not installed or not visible |
| `PLATFORM_NOT_SUPPORTED` | `org.freedesktop.DBus.Error.Spawn.*` | The bus launcher cannot start |
| `PLATFORM_NOT_SUPPORTED` | ``Failed to connect to address `unix:path=/run/user/1000/at-spi/bus_0,guid=...`: No such file or directory (os error 2)`` | The accessibility bus socket is missing (suggestion: restart the bus launcher). The same text with the session bus address means no session bus |
| `TIMEOUT` | "The accessibility bus did not answer in time" | A hung or slow bus: nothing learned |
| `INTERNAL` | "The accessibility bus returned an unexpected error" | An unclassified bus reply: retry once, then report it |
| `INVALID_ARGS` | "Native handle does not contain a Linux accessibility element" | A ref of another kind than the command accepts |

## Commands that refuse by design

- `key-down` and `key-up`: `ACTION_NOT_SUPPORTED`, `delivery: unknown`.
  `mouse-down` and `mouse-up` are `POLICY_DENIED`, `not_delivered`, headless and
  `ACTION_NOT_SUPPORTED` with `--headed`. No event is sent. Use `press` with
  modifiers and `drag`.
- `cursor-overlay` on Wayland: succeeds as a setting only. `enable` returns
  `data.rendered: false` and no overlay is drawn, so do not wait for one.
- `open-system-surface --surface taskbar`: `PLATFORM_NOT_SUPPORTED`. Use the
  advertised GNOME surfaces; see `references/shell-tray-and-notifications.md`.
- Ordinary app pointer commands and window screenshots on Wayland. Shell ref
  clicks also refuse on Wayland, and on X11 unless the shell's own tree proves the
  receiver.

## Missing tools

The binary needs no outside tool on X11. The Wayland clipboard needs
`wl-clipboard`. The X11 clipboard needs the helper
`agent-desktop-linux-clipboard-owner` beside the binary. The bus needs
`at-spi2-core`. A missing tool is reported by name with its package, never as an
empty result.

## Shared hosts

`TIMEOUT` with `lock_timeout` and a high `contention_count` means another agent
of the same user holds the interaction lock. Do not restart the user's
accessibility bus. Run a second bus only in a private runtime directory (see
`references/bus-and-permissions.md`).
