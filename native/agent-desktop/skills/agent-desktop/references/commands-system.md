# System Commands

App lifecycle, windows, notifications, clipboard, wait, batch, sessions, health. Run `agent-desktop <command> --help` for flags.

## launch

```bash
agent-desktop launch "System Settings"       # macOS display name
agent-desktop launch "TextEdit" --activate
agent-desktop launch "MyTool" --arg /tmp/notes.txt --env KEY=VALUE --no-attach
agent-desktop launch "Obsidian" --cdp
```

`launch` returns once the process runs. The identifier differs by OS: the examples use macOS display names, and the platform skill names the form for its OS. By default it attaches to a running instance. `--no-attach` starts a fresh instance instead of attaching: on Windows it returns `ACTION_FAILED` if a matching app is already running; on macOS it launches a second instance alongside the running one. For an `--arg` value that starts with `-`, use `--arg=<value>`.

The process running and the app showing a window are separate facts:

```json
{ "app": "TextEdit", "pid": 611, "window": { "id": "w-110407", "title": "Open", "visible": true } }
```

- `window` is present when the app already has one, and omitted when it has none. Its absence is not a failure. `launch` still returns `ok: true`.
- A document-based app may open its first window only when brought forward. Use `--activate`: it asks the app to present a window and waits for it up to `--timeout` (default 30000). This brings the app forward, so it is not headless. Or trigger the window yourself and use `wait --event window-opened`.
- A process that exits before it shows a window returns `APP_UNRESPONSIVE`.
- Windowless and menu-bar-only apps report no `window`. Use `list-apps` and read `presentation`.
- An app built on Chromium may return `renderer: "chromium"` and a `suggestion`. These are hints. The accessibility path still works. A missing `renderer` never proves the app is native.

### Web contents of a Chromium app (`--cdp`)

Use `--cdp` for Electron and Chromium apps whose web contents are dense or slow to walk (Slack, VS Code, Discord, Obsidian, Notion). It launches the app fresh with a loopback-only debugging port, polls until the endpoint answers, then returns. Pass a port, or omit it to let the OS pick a free one.

```json
{ "app": "Obsidian", "pid": 4821, "cdp": { "port": 9229, "http_endpoint": "http://127.0.0.1:9229",
  "websocket_url": "ws://127.0.0.1:9229/devtools/browser/<id>", "product": "Chrome/142.0.7444.265" } }
```

The port exists only for a fresh process. `launch` never quits a running app for you, because that loses the user's state. A running target returns `ACTION_FAILED` with `details.kind: "cdp_requires_fresh_launch"`. Run `close-app`, confirm the exit, then launch again with `--cdp`.

| `details.kind` | Meaning | Recovery |
|----------------|---------|----------|
| `cdp_requires_fresh_launch` | App already running | `close-app`, confirm exit, relaunch |
| `cdp_port_in_use` (`INVALID_ARGS`) | The named port is bound | Name another port, or omit it |
| `cdp_switch_conflict` (`INVALID_ARGS`) | `--arg` carried a `--remote-debugging-*` or `--remote-allow-origins` switch | Drop that `--arg` |
| `cdp_endpoint_unavailable` | No endpoint answered before the deadline | The app stays running. Use the accessibility path |

Handoff: agent-desktop never talks to the port itself. Check `command -v agent-browser`. If it exists, run `agent-browser connect <port>` and use its snapshot, click and type workflow (`agent-browser skills get electron` has the guide). Playwright, Puppeteer and other CDP clients also work. Do not write raw CDP by hand or call app-internal APIs. If no client exists, ask the user to run `npm install -g agent-browser`, or stay on the accessibility path.

Keep these on agent-desktop even with CDP connected: the native menu bar, file dialogs and sheets, window management, notifications, screenshots, and any app you did not launch. While the port is open, any local process of the same user can control the app's web contents. Request `--cdp` only for the step that needs it. `close-app` ends the exposure.

## close-app

`close-app` closes the app and all its windows. There is no `close-window`
command. To close one of several windows, snapshot the intended `--window-id`
and click its own Close button ref, then confirm the close with a `batch` of the
click and `wait --event window-closed`. Answer any save prompt through its
sheet. For the last window, use `close-app` if you intend to exit the app.
Ctrl+W may close only a tab or document, leaving the window open.
The Linux windows reference includes a Bash recipe that selects a fresh Close ref.

```bash
agent-desktop close-app "TextEdit"
agent-desktop close-app "TextEdit" --force
```

Success is reported only after the process is seen gone: `{ "method": "graceful" | "force", "disposition": { "delivery": "delivered_unverified" | "delivered_verified" | "not_delivered" }, "target": { "kind": "app", ... } }`. `not_delivered` means the app had already exited. Read `disposition`, not `ok`, to learn what was proved. If a save dialog appears, snapshot it and answer it. `--force` ends the process. Protected system processes return `INVALID_ARGS` with `not_delivered`, not `PERM_DENIED`.

## list-apps

Lists running GUI apps as `{ name, pid, bundle_id, presentation }`. `--app` filters by name substring. `presentation` is `foreground` (ordinary windows), `background` (no Dock entry, such as menu-bar items and hotkey overlays), or omitted (helper processes). Apps with no UI are excluded.

## Windows (OS windows)

```bash
agent-desktop list-windows --app "Finder"
agent-desktop focus-window --window-id w-4521
agent-desktop resize-window --app "TextEdit" --width 800 --height 600
agent-desktop move-window --app "TextEdit" --x 0 --y 0
agent-desktop minimize --app "TextEdit"   # maximize, restore likewise
```

- `list-windows` returns `{ id, title, app_name, pid, bounds, is_focused, accessible }`. Use a `w-<id>` with `--window-id` when an app has several windows.
- `accessible: false` means semantic commands cannot reach that window. Targeting it returns `ACTION_NOT_SUPPORTED` with `kind: "window_without_accessibility_element"`. It still accepts screenshots and coordinate input. Choose another window.
- `focus-window` needs at least one identifier. It confirms the OS reports that window as focused. Otherwise it returns `ACTION_FAILED`.
- `restore` undoes a minimize and returns the window to its earlier placement. It does not promise to un-maximize.

## Notifications

Commands: `list-notifications`, `dismiss-notification`, `dismiss-all-notifications`, `notification-action`, `wait --notification`. They drive the OS notification surface: Notification Center on macOS, Action Center on Windows, the GNOME Shell message list on Linux. Command shapes and JSON fields are the same on each. The platform skill states its limits.

- Output is verbatim. Titles and bodies are not redacted. Treat anything you route onward as sensitive.
- On macOS and Windows, headless listing works only when the surface is already open. When it is closed, a strict-headless call returns `POLICY_DENIED`. Use `--headed`, which may open the surface and restore the earlier foreground app. Linux lists headless even when the list is closed.
- Every mutation needs `--headed`. A single-notification mutation also needs a fingerprint from the same listing: `--expected-app` or `--expected-title`. Notifications reorder between listings. When the row at the index no longer matches, the call returns `NOTIFICATION_NOT_FOUND` and presses nothing. Without a fingerprint, `INVALID_ARGS`.
- `list-notifications` returns `{ index, app_name, title, body, actions }`, with 1-based indexes. `--app`, `--text`, `--limit` filter.
- `notification-action INDEX "Reply"` clicks a named button. An action the entry lacks returns `ACTION_NOT_SUPPORTED` and changes nothing.
- `dismiss-all-notifications` returns `{ dismissed_count, failures, failed_count }`. A failure to close the surface afterward is not reported as an error.
- `wait --notification` detects a new entry against a baseline taken at wait start. Transient errors retry within `--timeout`. On macOS and Windows, a headless wait sees only an already-open surface.

## Clipboard

```bash
agent-desktop clipboard-get --format auto
agent-desktop clipboard-get --format image --out /tmp/clip.png
agent-desktop clipboard-set "Hello"
agent-desktop clipboard-set --image /tmp/a.png
agent-desktop clipboard-set --file-url /tmp/a.txt --file-url /tmp/b.txt
agent-desktop clipboard-clear
```

- Formats: `text` (default), `auto` (file references, then image, then text), `image`, `file-urls`. Output is `{ "type": "text", "text": ... }`, `{ "type": "file_urls", ... }`, or `{ "type": "image", "path", "width", "height" }`. When the clipboard has nothing in that form: `{ "type": "<format>", "found": false }`.
- Image bytes go to `--out`, or to a private file under the active session directory (or `~/.agent-desktop/tmp`).
- `clipboard-set` writes one representation per call. `--file-url` and `--image` win over the positional text. Every `--file-url` path must exist, or `INVALID_ARGS`.
- A write that loses clipboard ownership mid-way reports `delivered_unverified`, not a false success.

## wait

```bash
agent-desktop wait 1000
agent-desktop wait --element @s8f3k2p9:e5 --predicate actionable --action type --timeout 5000
agent-desktop wait --element @s8f3k2p9:e5 --predicate value --value "Done"
agent-desktop wait --window "Save As" --app "TextEdit"
agent-desktop wait --text "Loading complete" --app "Safari"
agent-desktop wait --menu --app "Finder"
agent-desktop wait --event window-opened --app "Finder"
```

Use `wait`, not a fixed sleep. `--timeout` defaults to 30000 ms. Modes:

- **Time.** `wait <ms>` pauses.
- **Element.** `--predicate` is `exists` (default), `enabled`, `visible`, `actionable`, or `value` (with `--value`). `actionable` checks readiness for `--action` (`click` default, `type`, `set-value`, `clear`). Use `--action type` before a wait-then-type flow. The editability check runs only for editing actions. `--element` takes a qualified ref (`@<snapshot_id>:eN`); the wait polls the snapshot embedded in the ref.
- **Window.** Waits for a window whose title contains the text. `--app` narrows. On timeout, `details.last_observed` lists the scoped window count and up to eight titles.
- **Text.** Selects one app window, then waits for text in that tree. `--count N` waits until exactly N nodes match, and the result carries `count`. Several eligible windows, such as a document and its save dialog, return `AMBIGUOUS_TARGET` before any text check. `--window-id` does not narrow a text wait. To recover, find the target with `list-windows --app <app>` and inspect it with `snapshot --app <app> --window-id <id> -i`. For a dialog, use `wait --window <title> --app <app>`, then `snapshot --surface sheet` (see the dialog workflow). `--window` and `--text` are separate modes and cannot combine.
- **Menu.** `--menu` waits for a menu surface to open. `--menu-closed` waits for it to close.
- **Event.** `--event` is one of `window-opened`, `window-closed`, `app-launched`, `app-terminated`, `focus-changed`, `surface-appeared`, `surface-dismissed`. It diffs a baseline taken at wait start against fresh reads, so you need no window id up front. `--window-id` and `--window` narrow it.

For `wait --event` only, `--app` resolves once, at wait start, to one process instance. (`wait --window` filters by app name on every poll.) A later process of the same name is invisible to the wait. Two running instances return `AMBIGUOUS_TARGET`. When no app matches:

- `app-launched`, `window-opened`, `surface-appeared`: keep polling until the timeout. Use these when you race a launch.
- `app-terminated`, `window-closed`, `surface-dismissed`: return `"found": true` with `"target_unresolved": true` at once. A misspelled `--app` gives the same answer, so check the name.
- `focus-changed`: returns `APP_NOT_FOUND`.

On macOS and Windows, an existing window can still satisfy `--window` while its app is unresponsive. A wait can return top-level `APP_UNRESPONSIVE` before its timeout; handle that error directly. `wait --event` keeps polling after retryable read failures and includes the latest failure in `details.last_error` if it times out. A non-retryable error ends the event wait immediately.

The platform skills state the event and menu wait rules that differ by OS.

A `TIMEOUT` from `wait` carries `details.kind: "wait_timeout"`, `last_observed` or `last_error`, and `baseline_counts` for events.

## batch

```bash
agent-desktop batch '[
  {"command":"click","args":{"ref_id":"@s8f3k2p9:e1"}},
  {"command":"wait","args":{"ms":200}},
  {"command":"type","args":{"ref_id":"@s8f3k2p9:e2","text":"hello"}}
]' --stop-on-error

agent-desktop batch '[
  {"command":"click","args":{"ref_id":"@s8f3k2p9:e1"}},
  {"command":"wait","args":{"event":"window-opened","app":"TextEdit","timeout":5000}}
]' --stop-on-error
```

Batch runs entries in order in one process. It is not a transaction. Entries use the same typed commands, policy checks and dispatch as the CLI. Use `args`, not `params`. Unknown fields are rejected, and nested `batch` is rejected. Pass `--stop-on-error` to halt at the first failure. Each entry may carry `"session": "id"`, otherwise it inherits the top-level session. An entry whose session ended before dispatch is `not_started` with reason `session_ended`. An ended top-level session refuses the whole batch with `INVALID_ARGS` (`details.kind: session_ended`) before any entry runs. Snapshot args use `skeleton`, `root`, `interactive_only`.

Wait entries use flat JSON keys matching the wait argument fields. For event waits, use `event` and optional `app`, `timeout` (milliseconds; defaults to 30000), `window`, and `window_id`. For example, the batch above waits up to five seconds for a new TextEdit window. `window` and `window_id` narrow only window lifecycle events (`window-opened`, `window-closed`, `focus-changed`); they do not scope text waits. In an action-then-event sequence, the batch captures the event baseline before the action, and does not start the action if that baseline read fails.

## Sessions and traces

A session is an on-disk container under `<state root>/sessions/<id>/` with a manifest, snapshot refmaps and, when tracing is on, a `trace/` directory. The state root is `~/.agent-desktop`. `AGENT_DESKTOP_HOME` relocates it. It must be an absolute path, or the command fails with `INVALID_ARGS`. `status` reports it as `state_root`.

```bash
export AGENT_DESKTOP_SESSION="$(agent-desktop session start --name "invoice-bot" | jq -r '.data.session_id')"
agent-desktop session end "$AGENT_DESKTOP_SESSION"
```

- `session start` creates the session and prints `{ session_id, name, trace, created_at }`. `--name` must be 1 to 128 bytes with no control characters, or `session start` returns `INVALID_ARGS`. `session start` does not activate later processes. Pass the id with global `--session <id>` or `AGENT_DESKTOP_SESSION`. `--session` wins over the variable. With neither, commands use the global namespace.
- A session owns its trace and its latest-snapshot namespace. Lookup never searches another session. A session-owned ref still requires the same `--session` or `AGENT_DESKTOP_SESSION` scope, even though a qualified ref embeds its snapshot id.
- Tracing needs a manifest with `trace: on` (the default). `--no-trace`, or a bare `--session <id>` without a manifest, gives a namespace with no trace files. `--trace <path>` overrides to one file. `--trace-strict` fails on trace setup errors. `version` and `skills` write no trace events when run from the command line.
- `--screenshots` records pre and post PNGs and refmap copies. They are unredacted and sensitive. They need tracing on.
- Several agents may share one session id. Each should use qualified refs from its own snapshot.
- `session list`, `session end [id]` and `session gc` list, seal and reclaim sessions. `session end` is repeatable, including when the active scope has already ended; other commands refuse an ended scope, except `version` and `skills` when run from the command line. `session gc --ended` removes every ended session that no running command holds (only those older than `--older-than <secs>`, when given), trace segments included; plain `session gc` also keeps a session that wrote a snapshot or trace segment in the last 5 minutes.
- `trace show [--limit N] [--event PREFIX]` returns the merged event timeline (default tail 500, `0` for all). `trace export [--out path.html]` writes a self-contained HTML viewer. Without `--out` it writes `trace-<session>.html` inside the session directory, and `data.path` names the file. Both need no OS permission. Readers reject input beyond 32 MiB, 100,000 events, or 4,096 directory entries, regardless of the output limit. Session writers share a recording budget across processes and stop before those limits, reserving 16 directory entries for artifacts and bookkeeping. Start a new session to continue recording; existing events remain readable. Failed writes may consume reserved capacity. Older or externally modified traces beyond the limits must be split before reading. Only regular segment files are read; lines over 8 MiB are skipped with bounded buffering.
- Trace lines redact sensitive fields (`text`, `value`, `name`, `title`, `url`, ...) to `{ "redacted": true }`.
- `status` shows `session_id`, `tracing` and `artifacts`.

### Cursor overlay

`cursor-overlay enable` draws an agent cursor and ripple for actions. It affects presentation only. `enable` returns `data.rendered`: `false` means the setting was saved but nothing was drawn. `session start --cursor` enables it at start. `agent-desktop cursor-overlay enable --help` lists the style, image and motion flags with their ranges and defaults. Settings persist in the session and in per-agent profiles. After an upgrade, run `cursor-overlay disable`, then `enable`, to restart the renderer with the new settings.

On macOS:

- `--travel-ms MIN,MAX` needs `30 ≤ MIN ≤ MAX`. Travel max plus `--dwell-ms` must be at most 700 ms, or the command returns `INVALID_ARGS`.
- Reduce Motion skips travel and dwell. Physical headed drags keep their own motion.

On macOS and Windows:

- The label is a black pill with white text in the system font (SF Pro on macOS, Segoe UI on Windows), sized to the text and set below and right of the cursor's tip. A label wider than 360 pt is cut with an ellipsis, and an empty label shows no pill.
- `--accent` colours the cursor body as well as the ripple, the element outline and the caret; `--fill` gives the body a different colour.
- `--image` and `--pointer-image` take a PNG of at most 2 MiB and 1024 pixels per side, drawn at `--size` with the hotspot on the point the cursor targets. Relative paths resolve at `enable`. `--fill` and `--rim` conflict with `--image`. A missing or invalid image falls back to the arrow. With `--image`, `enable` draws no greeting.
- The pointer image shows on arrival at a pressable control. Text fields keep the arrow.

Windows accepts the motion settings but keeps its built-in motion.

On macOS and Windows, after `type` or `set-value` lands, the overlay draws the agent's caret, a thin bar in the accent color, at the field's insertion point and leaves the element outline off. `type --interval-ms` moves the caret with each keystroke while the cursor stays put. A field that reports no insertion point keeps the outline and gets no caret. The caret goes away when the cursor sets off for somewhere else, and stays for another `type` into the same field. After `press` delivers, a caret that is showing moves to the focused field's new insertion point, or disappears when the focused element has none. `type` plays the click ripple only when its field does not already have keyboard focus.

Multi-agent cursors (macOS and Windows): start with `session start --cursor --multi-agent`, then pass the returned session id to every subagent.

- Desktop UI actions then require an agent id: global `--agent-id <id>` or `AGENT_DESKTOP_AGENT_ID`. The flag wins. Observations, clipboard commands and session administration do not need one.
- An id has 1 to 64 letters, digits, `-` or `_`. It is scoped by session. Each distinct id gets its own cursor, and a reused id reuses its cursor.
- A headless action moves its cursor before it takes the interaction lease, so several agents' cursors travel at the same time. The actions still take turns, and commands that draw the same cursor take turns from its travel to its click effect.
- `--agent-id <id> cursor-overlay enable` saves a style for that agent. Do not add `--multi-agent` to it.
- `cursor-overlay disable` and `session end` stop every cursor in the session, even when you pass an agent id.

## status, permissions, version

- `status` returns adapter health, platform, the permission report, `supported_surfaces`, the latest snapshot (`snapshot_id`, `ref_count`), `session_id`, `tracing`, `state_root`.
- `permissions` returns `accessibility`, `screen_recording` and `automation`, each as `{ "state": "granted" | "denied" | "not_required" | "unknown" }`, with a `suggestion` when denied. It is cached per process. `permissions --request` asks the OS to prompt, through a bounded isolated helper so a stalled prompt cannot hang the command. It is the only path that prompts. On macOS, `permissions --guide` opens System Settings at the missing permission with an on-screen guide, adds `"guide": "started" | "already_running" | "not_needed"` to the result, and returns without waiting. Other platforms return `PLATFORM_NOT_SUPPORTED` for `--guide`. What to grant is in the platform skill.
- `version` returns `{ version, target, os }`.

## skills

Skills ship inside the binary. The JSON envelope holds the markdown in `data.content`.

```bash
agent-desktop skills                            # list skills and references
agent-desktop skills get desktop                # this skill
agent-desktop skills get desktop workflows      # one reference
agent-desktop skills get platform               # skill for the current OS
```
