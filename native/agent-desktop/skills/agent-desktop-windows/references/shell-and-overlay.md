# Shell surfaces, notifications and cursor overlay

Open this file to raise shell surfaces, read or drive notifications, use the cursor overlay, or handle hosted (UWP) window identity and menu detection.

## Shell Surfaces

`open-system-surface --surface <kind>` raises a shell surface and returns the
`w-<hwnd>` identity of the window it presents. Windows kinds: `start-menu`,
`taskbar`, `system-tray`, `system-tray-overflow`, `action-center`. Read the
surface with `snapshot --surface <kind>`. `snapshot --window-id` refuses that
handle with `WINDOW_NOT_FOUND`, because the window inventory excludes shell
windows.

- **The command takes the foreground.** Strict headless refuses it with
  `POLICY_DENIED` before anything is raised. Pass global `--headed`. An
  already-present surface is returned without being raised again.
- **`snapshot --surface <kind>` needs no `--app` and works headless.** A closed
  surface returns `WINDOW_NOT_FOUND` with a suggestion that names
  `open-system-surface`.
- **`quick-settings` returns `PLATFORM_NOT_SUPPORTED`** and names
  `action-center`, where the quick actions live.
- **`start-menu` is whatever the Win key raises.** Before Windows 11 that is a
  search overlay whose root holds a `SearchTextBox`, not a tile grid. Drive it
  as a search surface.
- **Tray items use the generic commands.** There are no Windows-specific tray
  commands. `snapshot --surface system-tray` returns the promoted
  notification-area items; zero items is a correct answer on a machine with no
  tray icons. `snapshot --surface taskbar` gives refs to the notification
  area's tray `button`s. `snapshot --surface system-tray-overflow` gives refs to
  the overflow items: raise the flyout first with
  `open-system-surface --surface system-tray-overflow`, or a click fails the
  occlusion check. A click on a `system-tray` item reports
  `delivered_unverified` with `retry: unsafe`, because a synthesized click
  cannot confirm what the owning app did with it. A click on an overflow item
  is untested.

## Notifications

The notification commands read and drive the Action Center through UI
Automation. The WinRT `UserNotificationListener` is never used, so its
per-machine consent setting cannot fail a call. The reader keys on landmark
`AutomationId`s: `MainListView` when notifications are present, an empty-state
shape when none are, and a top-level `ClearAllButton`.

- **The center must be open for a read.** `list-notifications` reads an
  already-open center headless. When the center is closed, strict headless
  returns `POLICY_DENIED` before raising it, and `--headed` raises it and
  restores the desktop afterwards. `dismiss-notification`,
  `dismiss-all-notifications` and `notification-action` always need
  `--headed`, and `wait --notification` refuses on its first poll under the
  same rule.
- **An empty center lists zero entries.** A center that shows neither the
  notification list nor the empty-state landmarks returns
  `PLATFORM_NOT_SUPPORTED` with a `platform_detail` that names the missing
  landmark. An unrecognized tree is an error, never an empty answer.
- **The index is not the identity.** Every mutation re-reads the center and
  compares the entry at the index with `--expected-app` and
  `--expected-title`. A mismatch is `NOTIFICATION_NOT_FOUND`. An action name the
  entry does not offer is `ACTION_NOT_SUPPORTED`.
- **A dismiss that does nothing fails.** The shell can accept an entry's
  `DismissButton` without acting on it. When the target is the only entry, the
  verified clear-all control runs instead. Otherwise the call reports
  `ACTION_FAILED` (`delivered_unverified`). `dismiss-all-notifications` is
  judged against the entries captured before the clear, so entries that arrive
  while it runs are not failures.
- **`wait --notification` opens and closes the center per poll**, as on macOS.
  Each poll adopts an already-open center and restores the entry state after.
  Measured cost: 1243.5 ms per poll at the minimum, 1254.2 ms at the median.
  The wait also sleeps up to 500 ms between polls, so size `--timeout` for
  both. A notification that appears and is dismissed inside one interval can be
  missed. A toast joins the center only while the center is open, so toasts
  posted between polls never land. To stage arrivals, hold the center open
  yourself; the polls adopt it without closing it.
- **This output is sensitive.** The notification-area surface shows the names
  of installed background agents, including security and remote-access
  products, and `list-notifications` returns titles and bodies verbatim.
  Nothing is redacted.

## Cursor Overlay

`cursor-overlay enable` renders on Windows: a detached renderer process paints a
presentation-only cursor in a click-through, topmost, non-activating window.

```powershell
$env:AGENT_DESKTOP_HOME = "$env:TEMP\ad-scratch"
$start = agent-desktop session start --cursor | ConvertFrom-Json
$env:AGENT_DESKTOP_SESSION = $start.data.session_id
agent-desktop cursor-overlay enable --label "Opening menu" --accent "#FF3B7B"
agent-desktop cursor-overlay disable
```

- **Start the session before you snapshot.** The overlay needs a session, and a
  snapshot taken outside it lands in the global namespace, where a
  session-scoped action cannot see it (`SNAPSHOT_NOT_FOUND`). Run
  `session start`, `cursor-overlay enable`, `snapshot`, then act.
- **`data.rendered` is the renderer's acknowledgement.** `enable` returns `true`
  only after a renderer connects to the session's control pipe and acknowledges
  the control. It returns `false` when no renderer could be reached, spawned or
  heard from in time. `disable` carries no `rendered` field. `session start
  --cursor` also enables the overlay and echoes only `cursor_overlay`.
- **Headed actions skip the travel animation.** A `--headed` action moves the
  real cursor, so the overlay does not animate travel or the click for it. An
  enabled overlay still paints its resting cursor.
- **It costs about 355 ms per action.** A headless `click` took 427 ms without
  the overlay and 782 ms with it. Enabling costs about 50 ms once. A hundred
  overlaid clicks add about 35 seconds.
- **It starts at the centre of the primary monitor's work area**, not over the
  app you drive. The first frame lands shortly after `enable` returns, so poll
  for the pixels before you take a screenshot.
- **It draws above the taskbar and other topmost shell chrome.**
- **It ignores the "Show animations in Windows" setting.** Windows reports
  animations off by default on a stock Windows Server host, so the explicit
  `enable` counts as the opt-in. macOS honours Reduce Motion instead.
- **The label is a black pill with white Segoe UI text**, sized to the text.
  `--fill` and `--rim` colour only the cursor, not the label.
- **The label shows only when there is something to say.** `enable` without
  `--label` greets once, and with `--image` it does not greet. After that,
  only an action that carries a description draws the label. Each `enable`
  and each action replaces the label text.
- **It fades out after 6 s with no instruction** and comes straight back on the
  next command.
- **The caret comes from the Text pattern.** After text entry, the agent's caret
  sits where the field's Text pattern places the insertion point, in a window
  of its own, and goes when the cursor sets off for somewhere else. A field
  without the Text pattern keeps the element outline.
- **It draws in physical pixels**, the space element bounds are reported in,
  so it is not scaled again for the monitor's DPI. Multi-monitor placement is
  unit-tested only and not verified on a live multi-monitor desktop.
- **A harness job object takes the overlay with it.** A job with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, which CI runners and some agent
  harnesses use, ends the detached renderer when the job closes. A vanished
  overlay there is not a renderer defect, and actions are unaffected.
- **Its control pipe trusts any process that runs as you.** See "The Cursor
  Overlay's Control Pipe" in `references/permissions-and-elevation.md`.
- **Teardown.** `cursor-overlay disable` ends the renderer for its session, and
  `session end` closes it too. When a session ends another way (a crash,
  `session gc`), the renderer reclaims itself within 3000 ms.

## Hosted (UWP) Window Identity

An app hosted in `ApplicationFrameHost` is reported through its frame:
`focused_window` and `list-windows` give the frame's handle as the window `id`,
which every window operation targets, while `app` and `pid` name the hosted
app, read from its `Windows.UI.Core.CoreWindow`. A suspended hosted app drops
its `CoreWindow`, so until it resumes the entry reads as its frame host, and
identities checked against the hosted pid fail closed.

## Menu Detection Coverage

The `menu` surface detector covers classic Win32 menus, WPF context menus and
menu-bar dropdowns, and Chromium/Electron DOM context menus drawn inside the
app's own window. WinUI3 and MSIX hosts are not evaluated. For an app outside
these families, read "no menu is open" as "not detected", not as proof that the
menu is closed.
