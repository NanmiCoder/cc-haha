# Windows and Lifecycle on Linux

Window control uses EWMH client messages on the X11 display: an X11 session's
display, or the Xwayland display of a Wayland session. `wmctrl` and `xdotool`
are not used.

## Naming an app

- `--app` takes the process name `list-apps` prints, or a desktop entry's `Name`
  or id whose `Exec` resolves to the running executable (`/proc/<pid>/exe`) with
  matching full arguments. A desktop name shared by several entries gets no
  alias. Registry labels and truncated `comm` names are never aliases.
- Scoped matching is exact and case-insensitive, and the process must belong to
  this session. `list-windows --app` uses that exact rule. `list-apps --app`
  combines a substring match on the listed name with those exact adapter aliases.
- Window ids are opaque addresses of 34 to 70 characters, valid for the life of
  the window's process.
- `list-apps` rows carry `name`, `pid`, `bundle_id` (desktop id when known) and
  `process_instance`. `list-windows` rows carry `id`, `title`, `app_name`, `pid`,
  `is_focused`, `minimized`, `visible`, `accessible` and `process_instance`, plus
  `bounds` when the display maps one.
- Several instances of one app share a name: pick one with `--window-id`.
  `close-app` and `launch` cannot choose and answer `AMBIGUOUS_TARGET`.
- Two windows of one process with the same title are told apart by the one the
  toolkit reports active: `focus-window --window-id` and the window operations
  act on the active one and, when exactly two share the title, on its twin. Any
  other tie (no active window, a window that is not the active one among three or
  more twins, an active window of another title) is refused with cause
  `ambiguous_window`.
- `list-windows` lists the focused window first, then the others in X11 stacking
  order, top to bottom. A window with no single X11 client (twins the active
  window does not separate, a Wayland session) follows in registry order.

## `launch`

```bash
agent-desktop launch gnome-calculator
agent-desktop launch gnome-text-editor --arg=/tmp/note.txt
```

- The identifier is an absolute path, desktop id, bare command or desktop entry
  `Name` (`launch "Text Editor"`), tried in that order. A relative path, or a
  name with a separator or NUL, is `INVALID_ARGS`, `not_delivered`; an unknown name is
  `APP_NOT_FOUND`; an entry with `Terminal=true` or no `Exec` is
  `ACTION_NOT_SUPPORTED`.
- The app is spawned with null stdio in its own process group, so a caller that
  reads through a pipe sees end of file at exit. Every spawn adds
  `AGENT_DESKTOP_LAUNCHED=1` to the child's environment; `close-app` reads it to
  tell an app you started from a session service.
- An absolute `.desktop` path launches that exact file inside the trusted XDG
  data directories. Desktop ids use XDG directory precedence.
- `launch` attaches to a running process only when the resolved executable
  equals its `/proc/<pid>/exe` and the full arguments and invocation name match.
  Missing evidence starts a new process; names alone never attach. A launcher
  that hands off to another executable is not followed by name: if no verified
  owner appears, `launch` reports the unresolved handoff.
- One verified match with no arguments returns the owner; arguments spawn the
  command to forward them. `--no-attach` refuses any verified running match with
  `ACTION_FAILED` naming its pids; without it, several verified matches are
  `AMBIGUOUS_TARGET`.
- `--arg` passes one argument and repeats; `--arg --info` works as written, and
  `--arg=-x` is the safe form for a value that starts with a hyphen. A handoff to
  a running instance applies the arguments but not `--env` or `--cwd`, and the
  result says so.
- Negative numbers need the `=` form: `move-window --x=-100 --y=-20`.
- A window result names its registry owner, verified by process identity. The
  command waits for a window: a registry owner gets a 2 s first-window grace, or
  5 s for a new window when windows were already open. `--timeout` (default
  30000) caps both; `--activate` uses the full remaining timeout for the window
  wait.
- A refused `--activate` does not fail `launch`: it answers `ok: true` with a
  `data.suggestion` that starts `The window could not be brought forward:` and
  gives the reason, and `window.is_focused` is `false`. Read `data.suggestion`:
  `window.is_focused` is the state before the request, so `false` alone does not
  show a refusal. `focus-window` on the window reports the cause.
- A window read that cannot prove the native window type of a frame
  (`details.kind: native_window_unproven`, which a window gives for the moment it
  changes during the read) counts as no window yet and is read again until the
  timeout, for an attach as well as a new launch. If no window is proven by then,
  `launch` answers `ACTION_NOT_SUPPORTED` with that kind: `not_delivered` when it
  spawned nothing, `delivered_unverified` after the spawn.
- If the spawned process never registers on the accessibility bus, owner lookup
  can consume the full timeout, and the result then has no `window`. A spawned
  process still running outside the registry can be returned without a window,
  and may be a wrapper. When no window appears the result can be `ok` with no
  `window`.
- A launcher that exits with no owner is `ACTION_FAILED`,
  `details.kind: exited` (`crashed` after a signal), `delivered_unverified`. An
  owner that exits before its window appears is `ACTION_FAILED`,
  `delivered_unverified`, without that kind. A forwarding launcher can attach to
  one existing instance of the same executable when that instance opens a new
  window, even if its argv differs. If no owner can be proven, including a
  handoff that only opens a tab in an existing window, the exited launcher can
  return `ACTION_FAILED`, `delivered_unverified`; re-list windows before retrying.
- The result carries `app`, `pid`, `process_instance` and, when one appeared,
  `window`. A no-argument attach returns an existing window of the running app. A
  new launch or argument handoff reports only a new window, so a handoff that
  opens a tab in an existing window can return no `window`.
- Chromium and Qt apps need a flag or an environment variable to appear on the
  bus; pass them with `--arg` or `--env`. Electron apps need none. See
  `references/troubleshooting.md`.

## `close-app`

`close-app` closes the app, including all its windows, and succeeds only when the
process is gone. The core `commands-system` reference covers closing one window.

A single-instance app such as GNOME Text Editor can hand a `launch` with arguments
to the instance that already runs. When exactly one matching instance opens a
new window, `launch` reports that instance and its new window. A handoff that
cannot be attributed can still return `ACTION_FAILED` (`details.kind: exited`,
`status: 0`) even if the request took effect. `close-app` closes every window of
the instance it targets, including windows you did not open.
To start an instance of your own, pass the app's own flag with `--arg` (Text
Editor: `--arg=--standalone`).

Example: with Text Editor windows `a.txt` and `b.txt` open, this Bash recipe uses
`jq` to select the unique `b.txt` window and its Close button, clicks it and
waits for that window to close. A window title reads
`b.txt (~/dir) - Text Editor`, so the filter matches the start of the title. The
recipe stops if either selection is ambiguous and does not pick the first match.

```bash
(
  set -euo pipefail
  window_id=$(agent-desktop list-windows --app gnome-text-editor |
    jq -er '[.data[] | select(.title | startswith("b.txt"))] |
      if length == 1 then .[0].id else error("choose one window") end')
  close_ref=$(agent-desktop snapshot --app gnome-text-editor --window-id "$window_id" -i --compact |
    jq -er '[.. | objects | select(.role? == "button" and .name? == "Close" and .ref_id?) | .ref_id] |
      if length == 1 then .[0] else error("choose the window Close button") end')
  batch=$(jq -nc --arg ref "$close_ref" --arg id "$window_id" \
    '[{command:"click",args:{ref_id:$ref}},
      {command:"wait",args:{event:"window-closed",app:"gnome-text-editor",window_id:$id,timeout:10000}}]')
  agent-desktop batch "$batch" --stop-on-error |
    jq -e '.data.results[1].data.event // error("the window did not close")'
)
```

The click returns before the window is gone, so a `list-windows` straight after
it can still list the window. The batch waits for `window-closed` and prints the
event of the closed window. If a save prompt appears, the wait times out:
snapshot `--surface sheet`, answer it, then run `list-windows`.

- Graceful close sends `_NET_CLOSE_WINDOW` to each top-level window of the pid and
  no signal. A file manager that outlives its windows ends in `TIMEOUT`,
  `delivered_unverified`; `--force` ends it. A terminal server closes like any
  other app under the name `list-apps` prints: `close-app gnome-terminal-server`
  ends it, and `close-app gnome-terminal` is `APP_NOT_FOUND`.
- An unconfirmed send is uncertain and unsafe to retry, even if the remaining
  fan-out runs out of time: observe the app first.
- A save prompt keeps the app open. The dialog is a new top-level window of the
  same pid, or a `dialog` or `alert` node drawn inside the window (libadwaita
  does this), counted in `details.dialogs`: read it with a plain
  `snapshot --app <name>` or `--surface sheet`, answer it, close again. A dialog
  already standing: `ACTION_FAILED`, cause `dialog_pending`, `not_delivered`,
  `retry: safe`, nothing sent. A dialog that opens in answer to the request ends
  the wait with the same cause, the title in `details.dialog`,
  `delivered_unverified`, `retry: unsafe`. One request can open a prompt for
  every window with unsaved work, so `dialogs`, `windows_remaining` and
  `dialog_titles` all come from one read taken once the windows stop changing and
  agree with one another.
- Several prompts are separate modal windows and answer in any order: a plain
  `snapshot --app <name>` is then `AMBIGUOUS_TARGET` and lists the window ids,
  and `snapshot --window-id <id>` roots one. A ref in a window behind a prompt is
  `ACTION_FAILED`, cause `blocked_by_modal_dialog`, `not_delivered`. Prompts
  that share a title can look the same on the display; a `--headed` ref action
  in one is then `AMBIGUOUS_TARGET`, `window_position_ambiguous`,
  `not_delivered`: answer it without `--headed`.
- `--force` sends `SIGTERM` through a pidfd, then `SIGKILL` after 2 s; a stopped
  process gets `SIGKILL` at once.
- A process of a Wayland session with no X11 window is `ACTION_NOT_SUPPORTED`,
  cause `wayland_session`.
- Protection follows the target process instance, never its name. `INVALID_ARGS`,
  `not_delivered`, for:
  - the owner of the active display socket, or of the X root's supporting-WM
    window;
  - an app that answers on the accessibility bus, shows no window (one the
    window manager manages, or one its accessibility tree lists: a native Wayland
    window is only there) and was started by the session (it owns a session-bus
    name, runs as a user service unit, or is a child of the display owner: portal
    backends, shell helpers, decoration hosts), unless this tool launched it.

  A process that does not answer on the accessibility bus (stopped or hung) is
  protected when it owns a session-bus name and the window manager manages no
  window of it, unless a launch of this tool started it. A stopped app with a
  window is not protected, whoever started it: `--force` ends it.
  Missing ownership evidence (such as an unreadable `/proc` entry or no session
  bus) is `ACTION_NOT_SUPPORTED` before anything is sent; an unreachable display
  is `PLATFORM_NOT_SUPPORTED`. X11 manager ownership needs XRes process IDs;
  missing server support refuses.

## Window operations

`move-window`, `resize-window`, `minimize`, `maximize` and `restore` use EWMH.
Move and resize read back geometry inside 250 ms with a 2 px tolerance; minimize
and maximize read back their state. Their successful reports name
`details.verification_scope`. `restore` has no uniform final read-back across its
branches and reports `delivered_unverified`: look at the window afterwards.
Reports carry `action`, `target`, `steps` and `disposition`, without a `moved`,
`resized` or other unconditional success flag.

- A clamp or an ignored request is `ACTION_FAILED`, `delivered_unverified`, with
  the requested, observed and display bounds; the window may still have changed
  in part: read the bounds.
- A resize is judged by its size alone. A window manager that moves the window
  to keep it on the display changes the origin, not the verdict, and the report's
  `details.observed` holds the read-back, origin included.
- A `restore` the window manager answered without showing the window is
  `ACTION_NOT_SUPPORTED`, cause `restore_refused`, `delivered_unverified`, with
  `details.manager`. While the GNOME Activities Overview is open the cause is
  `overview_open` (`ACTION_FAILED`): press Escape to close it, then look at the
  window before you retry.
- Without `--app` or `--window-id` all five act on the focused window, and
  `data.target` names the window id, title and process identity, even when no
  selector was supplied. Pass one unless you mean the focused window.
- A Wayland-native window, and an un-minimize on a Wayland session, are refused
  with cause `wayland_session` before anything is sent.
- A window the process cannot be mapped to is refused before any write: no client
  is `ACTION_NOT_SUPPORTED`, cause `window_not_mapped`; two clients are
  `AMBIGUOUS_TARGET`, cause `ambiguous_window`.
- A window manager may ignore a restore sent 1 to 2 s after a minimize, or a
  minimize sent within about 250 ms of a restore: read the window state before
  retrying. An unconfirmed restore send is uncertain and unsafe to retry; it may
  already have restored the window.
- `move-window` needs both `--x` and `--y` (a lone one is `INVALID_ARGS` at parse
  time, exit 2). Negative coordinates need the `=` form:
  `move-window --x=-100 --y=20`.

## Focus

```bash
agent-desktop focus-window --app gnome-calculator
```

`focus-window` succeeds only when `_NET_ACTIVE_WINDOW` names the window and its
application reports it active: its frame or another frame of the app carries
`ACTIVE`, one of its menus is open, or it is a modal or dialog frame that holds
the input focus without `ACTIVE`. After the request is sent, a failed read-back
or a modal refusal is `delivered_unverified` and unsafe to retry. An unconfirmed
send is uncertain delivery, and a later timeout does not make the earlier request
safe to repeat.

- A minimized or hidden target is lifted first. A stopped target is
  `APP_UNRESPONSIVE` before anything is sent.
- When a modal dialog holds the focus, `focus-window --app <name>` succeeds with
  the dialog as `data.focused`. Read `data.focused.title` and act on the dialog,
  not the window you named.
- A window the manager never activated can end `ACTION_FAILED` with cause
  `activation_not_granted` (under mutter, until a window has held focus once).
  Other timeouts end with `activation_refused` (another window stayed active) or
  `frame_not_active` (the manager named the window, but its frame never reported
  `ACTIVE`).
- While the GNOME Activities Overview is open the cause is `overview_open`; close
  the overview first. A fresh GNOME shell opens it and it blocks activation for
  every window. Send a global `--headed press escape` (no `--app`), then call
  `focus-window --app <name>` again. A headed ref action runs `focus-window` for
  you and ends the same way.
- A Wayland session is `ACTION_NOT_SUPPORTED`, cause `wayland_session`.
- A headless ref `click` on a minimized window refuses with live `offscreen`
  evidence and leaves it minimized. On X11, `--headed click`, `--headed hover`
  and `--headed drag` first focus the ref's exact source window, restoring it if
  minimized, then deliver the gesture; they refuse if the window manager cannot
  show and activate that window, or if the target stays hidden, offscreen or
  occluded after focus. An unsupported
  physical route or geometry refusal can fall back to semantic click only when it
  proves nothing was sent. Ordinary-app headed pointer actions on Wayland refuse
  with cause `wayland_session` before delivery. Use `restore` to restore a window
  without clicking it.

## Workspaces

A window on another workspace lists `visible: false` and cannot take a headless
`press`. `focus-window` brings it forward by switching the user's workspace:
decide whether that is acceptable before you call it.

## `press --app` and background targets

Headless `press --app <name>` delivers only while the target process owns the
active window. On X11 a background or minimized app is refused: `ACTION_FAILED`,
`check: window_active`, cause `display_active_window`, `not_delivered`; the
message says the application's active window could not be confirmed. `--headed`
brings the window forward, un-minimizes it and sends the keys (X11). On Wayland,
`focus-window` and headed app- or window-scoped `press` refuse with
`ACTION_NOT_SUPPORTED`, cause `wayland_session`, Xwayland clients included.

Headless scoped `press` does not activate a window: it requires the live focus
guard to confirm the target. If focus cannot be confirmed, bring the target
forward yourself and use global `press` (no `--app`, `--window-id` or
`--headed`). A headless `press --window-id` with unconfirmed exact window focus
returns `STALE_REF`, `check: exact_window_focus`,
`cause: exact_window_focus_unconfirmed`, `not_delivered`: bring the window
forward, refresh `list-windows`, retry with its current id.

## Stopped apps

An app stopped with `SIGSTOP` is detected from `/proc` without waiting for a
probe. A ref used against it, a scoped `snapshot`, `list-windows --app`,
`focus-window` and the window operations answer `APP_UNRESPONSIVE` in
milliseconds, not `STALE_REF`. `close-app` answers `APP_UNRESPONSIVE`,
`not_delivered`, `retry: safe`; `--force` ends it, unless it is a session service
(`INVALID_ARGS`, see `close-app`). A stopped native-Wayland app that owns a
session-bus name is one: no window of it can be read. An unscoped `list-windows` still lists its
windows with `accessible: false`. A scoped listing of a busy app
that left every frame unanswered is `TIMEOUT`, not an empty list.

## Waiting for lifecycle events

```bash
agent-desktop wait --window "Calculator" --app gnome-calculator --timeout 10000
agent-desktop wait --event window-opened --app gnome-calculator --timeout 10000
```

`wait --event` takes `window-opened`, `window-closed`, `app-launched`,
`app-terminated`, `focus-changed`, `surface-appeared` and `surface-dismissed`. It
diffs a baseline taken at the start against fresh reads. On Linux:

- An app counts as launched when it owns a window. A windowless helper never
  produces `app-launched`; a second window of a running app (`--new-window`) is
  `window-opened`, never `app-launched`. A Qt process registers twice and counts
  once.
- A dialog that is its own top-level window is one `window-opened` and one
  `surface-appeared`. An unscoped `window-opened` sees it (measured on a Nautilus
  "New Folder" dialog); `surface-appeared` and `surface-dismissed` need `--app`
  (`INVALID_ARGS`, "requires --app" when unscoped); a dialog drawn inside its
  window is found only when `--app` scopes the wait, and it appears 0.7 to 1.5 s
  after the action that opened it.
- `focus-changed` needs a window that reports `ACTIVE`. On Wayland none does
  until a seat keyboard exists, so it times out with `baseline_counts`.
- A wait scoped to a stopped app fails at once with top-level
  `APP_UNRESPONSIVE`, `not_delivered` and `retry: safe`, not `TIMEOUT`, in every
  mode (`--event` included). A `batch` of an action followed by such a wait does
  not start the action (`pre_action_baseline_failed`). An app that is alive but
  slow keeps the wait polling; classes that could not be read are left out of the
  diff and no event is invented from them.
- A `batch` is `ok: true`, exit 0, even when an entry fails: each entry carries
  its own `ok: false` and `error`. Read every entry.
- `--menu-closed` on a menu you have not opened is true at once: wait for `--menu`
  first, then close the menu, then wait for `--menu-closed`. After an action of
  your own, the closed wait holds until the menu was seen open, or for 2 s.
- A hidden menu bar opens nothing, so `--menu` times out with "No menu opened
  before the deadline".
- For an already-focused menu or Save As dialog, `agent-desktop press escape`
  sends Escape to the current keyboard focus. Omit `--app` and `--window-id` for
  this global form: scoped delivery checks the application's active frame, while
  a popup can own the keyboard grab. Confirm the intended app is focused first,
  then verify closure with `wait --menu-closed --app <name>` or a fresh
  window/sheet observation. Escape alone does not prove closure.
- A window that neither shows nor is iconified is a closed window's husk and is
  left out of every list (unless the window manager lists a client of it that no
  shown window claims), so `window-closed` fires when the dialog closes.
- `wait` pauses at most 100 ms between polls (50 ms for menu waits) and
  re-resolves a ref on every poll. A wait for a `--window` can finish before its
  content is ready.
- `--window` is its own wait mode, not a `--text` filter. With `--event` it
  narrows the event by title, and `--window-id` narrows event waits only. Both
  work only with `window-opened`, `window-closed` and `focus-changed`; any other
  `--event` with them is `INVALID_ARGS`.
- `wait --text --app` can return `AMBIGUOUS_TARGET` before it checks the text,
  when visibility, focus and accessibility do not select one window (a document
  and its dialog). For a save prompt, run the close and the wait in one `batch`,
  so the wait reads its baseline before the prompt opens (a wait started after
  the prompt is already open sees no change and times out), then snapshot the
  sheet (a separate window or an alert drawn inside the window):

  ```bash
  agent-desktop batch '[{"command":"close-app","args":{"app":"gnome-text-editor"}},{"command":"wait","args":{"event":"surface-appeared","app":"gnome-text-editor","timeout":5000}}]'
  agent-desktop snapshot --app gnome-text-editor --surface sheet -i --compact
  ```

## Window classification

`list-windows` classifies frames from AT-SPI roles, interfaces and state, plus,
on X11, window-manager ownership, native window type and override-redirect
evidence. Class names, titles and process names never classify a window. When
a frame's process has no managed window, it leaves the frame out if that process
owns no visible native window on a complete read, or if the session itself owns
it: the shell's own window, decoration frames a window manager hosts, and on
Wayland the compositor's frames. A process this tool launched is never hidden
that way. Minimized frames stay listed, and a frame whose class is unclear stays
listed on its accessibility evidence alone.
