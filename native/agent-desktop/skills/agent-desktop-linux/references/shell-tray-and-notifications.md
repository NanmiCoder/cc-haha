# Menus, Shell, Tray and Notifications on Linux

Run inside the target desktop session. `agent-desktop status` lists snapshot
capabilities, not proof that a popup is open or a tray watcher is running.
Openbox is an X11 window manager without GNOME Shell. Mutter here means a GNOME
Shell session on X11. GNOME Shell supplies the Wayland surfaces.

## App menus and GTK4 popovers

`window`, `sheet` and `menu` are available with a healthy accessibility bus on
all three backends. After an opener, read its `data.surfaces`: a `type: menu`
entry means snapshot the menu next. If it is absent, wait for the menu, then run
`list-surfaces --app gnome-calculator`. GTK4 popovers appear asynchronously. An
incomplete scan marks `menu` in the window entry's `unclassified` list, so an
absent menu in that result does not prove it is closed.

This example needs a running Calculator and `jq`, and finds a fresh opener ref.
On Mutter X11, first close Overview and focus Calculator with the recovery
below: while Overview covers the app, a click can report success without opening
its menu. Inspect each command's JSON result, waits included.

```bash
menu_ref=$(agent-desktop snapshot --app gnome-calculator -i | jq -r '.. | objects | select(.role? == "switch" and .name? == "Main Menu") | .ref_id // empty')
test -n "$menu_ref" && agent-desktop click "$menu_ref"
agent-desktop wait --menu --app gnome-calculator --timeout 5000
agent-desktop list-surfaces --app gnome-calculator
agent-desktop snapshot --surface menu --app gnome-calculator -i
agent-desktop press escape
agent-desktop wait --menu-closed --app gnome-calculator --timeout 5000
```

- `list-surfaces` lists the app's windows, sheets and open menu, with
  `item_count` on the menu.
- `snapshot --surface menu` roots at the popup. `find --surface menu` uses the
  same scope.
- Menu refs identify the actual AT-SPI object within a freshly verified,
  complete popup context, labels and tree shape included.
- A named GTK4 popover item (Calculator's Preferences) can be found and clicked
  through that identity while its popup has a provable screen position. On
  Wayland it has none: the ref is refused at resolution with `ACTION_FAILED`,
  `details.check` `geometry`.
- An unreadable context or multiple matching targets is refused before delivery.
- After closure the same ref returns `STALE_REF`, `details.kind: menu_closed`. A
  snapshot of a closed menu returns `ELEMENT_NOT_FOUND`, "The window does not
  present an open menu". Open again and take new refs.
- An open popup whose content changed returns `menu_context_changed`. An
  incomplete context read returns retryable `menu_context_unknown`. Keep it open
  and take a fresh menu snapshot before using a new ref.
- A menu button whose popover holds only a label verifies `expand` and
  `collapse`, and a second `expand` on it succeeds without delivery. Both take
  about 0.6 s: the GTK4 popover animates and the check polls it every 50 ms.
- If opening a popover changes the opener's accessible name (Calculator
  `Advanced` becomes `Advanced Advanced`), take a fresh snapshot before
  collapsing; refs are valid for one snapshot.

| Toolkit | Exposed menu shape and boundary |
|---------|--------------------------------|
| GTK3 | Menu-bar child or separate context-menu window |
| GTK4 / libadwaita | Popover within the frame; item names can be recovered from their labels |
| Qt | `QMenu` popup; a `QLineEdit` context menu may expose nothing through AT-SPI |
| Chromium | Native context/toolbar popup in a separate frame; web content is not a general menu-surface API |

- A visible menu bar alone is not an open popup.
- `wait --menu` and `wait --menu-closed` use the same detector as menu
  snapshots. Scope them with `--app`.
- `press escape` sends a global key without first activating the parent window.
  It can report `delivered_unverified` while the menu stays open, so confirm
  with `wait --menu-closed`: a `TIMEOUT` with `predicate: menu` ("Menu did not
  close before the deadline") means it is still open.

In a headless Wayland session, global `press` can leave the seat without a
keyboard after its temporary RemoteDesktop session ends. A GTK4 opener can then
become expanded without presenting a native menu, and the tool reports
`ACTION_FAILED`, `popup_not_observed`, with unverified delivery and unsafe retry.
A keyboard present from app launch and kept across the commands avoids this;
adding one after the failure does not recover the popup. An expanded opener
alone never proves an open menu: inspect the native menu before continuing.

GTK4 raw menu items can be unnamed while the snapshot shows their labels. A
readable label does not establish a safe physical click position. Ordinary app
pointer actions on Wayland refuse with `ACTION_NOT_SUPPORTED`, cause
`wayland_session`. On X11, use physical input only after observing a usable
popup position, and verify its effect. A successful input report alone does not
prove an item was picked.

GTK4 list-backed dropdowns, such as Settings' Night Light Schedule, are not
menu-role popups. Their choices stay in the window tree: `wait --menu` and
`snapshot --surface menu` do not cover them. Find the combobox, click its fresh
ref, and use `wait --text` for a choice before taking a window snapshot.

A combobox with no popup state, no selection and no action, such as a libadwaita
combo row, takes `--headed select @ref "Choice"` on X11. It clicks the combobox,
finds the choice in the list that appears, selects it through that list and the
popup's default action, and checks the value the combobox shows. A missing
choice closes the popup with Escape and answers `ELEMENT_NOT_FOUND`. Without
`--headed` that select is `POLICY_DENIED`, kind `pointer_required`, unless the
combobox already shows the choice. Where `select` still refuses, adding
`--headed` does not supply a missing semantic action.

On X11, after a headed click focuses the open dropdown, explicit headed
`press down` / `press up` and `press return` can choose an item. Inspect the
current choice first and verify the resulting value before another mutation. If
`get` returns only the combobox label, use `snapshot --root` on its fresh ref to
read the displayed value. A successful key report does not prove the choice was
committed.

## GNOME Shell: Overview, top bar and popups

Shell identity comes from the session-bus owner of `org.gnome.Shell`, correlated
with its accessibility-bus process. Process names and translated labels cannot
prove it. Advertised surfaces require a resolvable structural container.

| Surface | Meaning | Availability |
|---------|---------|--------------|
| `system-tray` | Logical watcher items and their virtual menus | Headless snapshot with a StatusNotifierWatcher; no native panel binding |
| `action-center` | The container above the footer row of a label, a toggle and a push button | Content while the list is showing; `open-system-surface` opens it with a click on the date menu |
| `quick-settings` | System menu | Refuses: the exposed generic panel chain cannot prove its container |
| `taskbar` | Dock | Not advertised or openable |

- Shell snapshots need no `--app`. `list-surfaces` inventories an app selected
  with `--app`. Shell containers do not appear in `list-windows`.
- Role shape and uniqueness find the message list and the date menu that opens
  it. English labels, wrapper depth and screen position prove nothing. A shell read that keeps losing a node refuses with `shell_container_unproven`; retry once the shell settles.
- Other containers and the system-button opener return `ACTION_NOT_SUPPORTED`,
  `shell_container_unproven`, before input. Opening a hidden popup headless
  still requires headed permission.
- Overview is not a `--surface` value (`INVALID_ARGS`). On Mutter X11, while
  Activities Overview is open, headed app focus returns `ACTION_FAILED`, cause
  `overview_open`. Send global `agent-desktop press escape`, then
  `agent-desktop --headed focus-window --app gnome-calculator` before the app
  action. This X11 recovery does not establish Wayland window-control support.
- Native shell clicks need headed permission and, on X11, a tree hit test before
  any pointer event. The shell answers no point query finer than a container, so
  the adapter reads every showing shell node in paint order. The last node over
  the aim point must be the target or lie below it, and the target's extents
  must read the same twice, at least 50 ms apart.
- A node painted over the target, a target that is still moving, or a target
  that is not showing or has left the tree refuses with `ACTION_FAILED`,
  `pointer_hit_unproven` and no delivery. Retry once the shell settles. Another
  node that leaves the tree or answers no role during the read leaves the click unproven, because it may have covered the target.
  Each effect is read back from the shell.
- On Wayland a headed shell ref click refuses with `ACTION_NOT_SUPPORTED`, cause
  `wayland_session`, before any input, and a popup opener refuses with
  `pointer_hit_unproven` because the shared hit test cannot prove its receiver.

## Service requirements and exact refusals

The shell accessibility tree, notification daemon and tray watcher are separate
requirements. A healthy app bus does not establish any of them.

| Missing requirement | Result |
|---------------------|--------|
| Shell session owner or matching accessibility tree | Cause-specific missing-tree refusal; no guessed shell identity |
| Unproven shell container or opener | `ACTION_NOT_SUPPORTED`, `shell_container_unproven` |
| No notification service | `PLATFORM_NOT_SUPPORTED`, `daemon: absent` |
| Notification service owner is neither the shell nor a process of the same user whose argv names the shell's own notification module | `PLATFORM_NOT_SUPPORTED`, `daemon: unsupported`; server branding is not identity |
| No `org.kde.StatusNotifierWatcher` | `PLATFORM_NOT_SUPPORTED`, `watcher: absent`; guidance names the required protocol backend |
| Unreadable notification service | `TIMEOUT`, `daemon: unreadable` |
| Unreadable tray watcher | `TIMEOUT` when its call times out, otherwise `INTERNAL` |

An unavailable daemon is not an empty notification list. An absent watcher is
not an empty tray. Do not restart a shell or accessibility bus you do not own.

## Notifications

**Every notification field comes from the shell's widget layout.** Neither the
notification protocol nor GNOME's accessibility tree names a notification's app,
title, body, age or controls, so the adapter reads them where the shell puts
them. Verified on GNOME Shell 46.0 (Ubuntu 24.04) in private Mutter X11 and
native Wayland sessions, and on no other version. A shell that lays an entry out
differently is refused (`INTERNAL`, "no readable title") or misread, never
repaired by guessing. The adapter uses no text, English word or footer button
position to find the list, an entry or its parts. `notification-action` only
matches the action name you pass.

- `list-notifications` reads GNOME Shell's message list headless, including when
  closed, and excludes banner copies.
- Indices are 1-based positions in the unfiltered list, newest first. Filtering
  does not renumber them.
- `--app` is case-insensitive contains. `--text` searches app, title and body.
  `--limit N` keeps the first N entries after the filters, each with its own
  index.
- An empty list is a successful empty result.
- `wait --notification` establishes a baseline and waits for a matching entry
  new to that baseline.

How an entry is read:

- The list is the container directly above a footer row whose children are, in
  order, a label, a toggle and a push button. An empty list is that container
  with no entry.
- The header is the container holding an entry's unnamed push buttons. Its first
  label is the app. Later labels are the age and are dropped.
- Labels outside the header are the title, then the body. Named push buttons
  outside the header are the actions.
- An entry with no such header cannot be read, and the command fails.

The protocol has no history query and GNOME exposes no notification ID, so an
index is a position, not an identity. Within one command an entry is its
accessibility object plus its words. Every single-item mutation reads the list
twice, checks the expected app and title at the index, checks that both reads
found the same object, and proves the effect by the object leaving the list.

The example assumes exactly one disposable notification from `Skill Example`,
titled `Beta`, already exists. `jq` selects the actual index, and the mutation
guards both identity fields:

```bash
agent-desktop list-notifications
notice_index=$(agent-desktop list-notifications --app "Skill Example" --text Beta | jq -r '.data.notifications[] | select(.app_name == "Skill Example" and .title == "Beta") | .index')
test -n "$notice_index" && agent-desktop --headed dismiss-notification "$notice_index" --expected-app "Skill Example" --expected-title Beta
agent-desktop list-notifications --app "Skill Example"
```

Single-item `dismiss-notification` and `notification-action` require
`--headed` and at least one of `--expected-app` / `--expected-title`.
`dismiss-notification` returns the entry it removed as `data.dismissed`.

- No identity flag: `INVALID_ARGS`. Headless mutation: `POLICY_DENIED`,
  `dismiss-all-notifications` on an empty list included.
- Missing index or changed identity: `NOTIFICATION_NOT_FOUND`. `--app` does not
  renumber the list: INDEX stays the position in the unfiltered list, and the
  command answers `NOTIFICATION_NOT_FOUND` unless that entry is from the named
  app.
- Re-list after each mutation: an index can name another notification
  afterwards.
- Mutations press the shell's controls with the pointer, which needs X11. On
  Wayland a mutation fails with `ACTION_FAILED`, `pointer_hit_unproven`, before
  any input.
- The command opens a closed message list by a click on the clock menu and
  closes it again after the call. If it cannot open the list, the error
  suggestion says so: open the list by hand and retry, because a list that is
  already showing is used as it is and left showing.
- Dismissal presses the entry's header buttons, last one first. The two look
  alike, so the effect decides: afterwards the entry's own object must be gone
  from the list and no other entry's may be. A button that only expands the
  entry leaves it standing, so the other is pressed next.
- An entry still standing after both buttons is `ACTION_FAILED` with
  `delivery: delivered_unverified`, never success. A partial post-click read
  gives the same code with "The click was delivered but the message list could
  not be read afterwards" and `retry: unsafe`. The target may already be gone.
  Re-list before deciding what remains. Do not repeat the old index blindly.
- `dismiss-all-notifications` closes each entry in scope through its own header
  buttons, one at a time, and counts an entry as dismissed only when its own
  object has left the list. It never presses the footer button, which has no
  property but its place. `--app` limits the scope. A headed empty dismiss-all
  returns zero without opening the message list. `dismiss-all-notifications`
  returns `data.dismissed_count`, and `data.failures` with `data.failed_count`
  for entries that could not be closed.
- For `notification-action`, pass a name from the row's `actions` list, for
  example `Open`. The match ignores case. A missing action is
  `ACTION_NOT_SUPPORTED` with `available_actions`. If the entry's buttons are
  not laid out, the command first expands it with the header button before the
  last one. If that press removes the entry instead, the result is
  `ACTION_FAILED`.
- An action counts only when the entry's object leaves the list, which GNOME
  does after an action unless the notification is resident. `details.evidence`
  is `action_invoked` when the daemon's own `ActionInvoked` signal was also seen
  once, and `entry_removed` otherwise. The result is always
  `delivered_unverified`, and the receiving app's effect is never claimed. A
  button pressed while the entry stayed in the list is `ACTION_FAILED` with
  `delivered_unverified`.

## Surfaces that `open-system-surface` accepts

`open-system-surface --help` shows the values of every platform. On Linux only
two can work:

| Value | Result |
|-------|--------|
| `system-tray` | Needs `org.kde.StatusNotifierWatcher`. Without it: `PLATFORM_NOT_SUPPORTED`, `watcher: absent`, the same refusal as `snapshot --surface system-tray`. No window is returned |
| `action-center` | Opens the GNOME message list when its container and opener are proven; otherwise `ACTION_NOT_SUPPORTED`, `shell_container_unproven` |
| `quick-settings` | `ACTION_NOT_SUPPORTED`, `shell_container_unproven`, before any input |
| `taskbar` | `PLATFORM_NOT_SUPPORTED`: no stock shell shows a dock |
| `start-menu`, `system-tray-overflow`, other values | `PLATFORM_NOT_SUPPORTED`, not supported on this platform |

Retrying an unsupported value gives the same refusal.

## StatusNotifierItem and AppIndicator tray

Tray snapshots require `org.kde.StatusNotifierWatcher`. The adapter reads its
registered items and `org.kde.StatusNotifierItem` properties. Arbitrary XEmbed
icons are not SNI items. Install or enable a backend only for the session you
own. GNOME commonly obtains one through AppIndicator.

`snapshot --surface system-tray -i` exposes watcher items beneath a logical
root, with `com.canonical.dbusmenu` entries as virtual children. Titles,
including `System` and duplicate titles, never bind a native panel node. A
`Passive` item remains in the snapshot with `states: [hidden]`, and a click on
it refuses with `ACTION_FAILED` before any call is sent.

- These refs are virtual protocol identities, not AT-SPI elements. Native text
  getters can return `INVALID_ARGS`, `invalid_native_handle`. Bounds, placement
  and offscreen state are unknown. No paired native item supplies geometry.
- Headless `click` uses advertised `Activate`. `right-click` uses `ContextMenu`.
  `SecondaryActivate` and physical panel clicks never substitute for a missing
  primary method. Use a virtual menu entry when the item omits those methods.
- Headed permission supplies neither native geometry nor a pointer fallback.
  Wayland headed pointer policy can refuse earlier with `wayland_session`.
- SNI methods report `delivered_unverified`. A menu pick reports
  `delivered_verified` only when its toggle state flips or its submenu children
  appear, and `delivered_unverified` otherwise. Independently observe the
  receiving application before deciding whether to repeat them.
- A menu-entry `click` re-resolves the label path and entry ID in a fresh
  layout. A changed revision alone does not invalidate an otherwise identical
  entry. An entry that is gone or replaced refuses with `STALE_REF`, and a label
  repeated at one level with `AMBIGUOUS_TARGET`, before any event is sent.
- An enabled leaf sends `Event(..., clicked, ...)`. A submenu uses `AboutToShow`
  and rereads for children.
- Disabled entries are not clicked and refuse before delivery. The actionability
  gate may report `TIMEOUT`, `kind: actionability_timeout`, with a failed
  `enabled` check and reason "live enabled state is false" in
  `last_report.report.checks`. `--headed` does not make them enabled. On Wayland
  its earlier pointer gate can return `ACTION_NOT_SUPPORTED`, cause
  `wayland_session`, instead of waiting. Neither route sent the disabled entry's
  event.
- Owner exit makes old refs `STALE_REF`. Tray items accept click/right-click.
  Menu entries accept click. Other actions can be refused by policy first or
  `ACTION_NOT_SUPPORTED` in the adapter.

## Sandboxed apps

An app in a sandbox is on the accessibility bus only when the sandbox shares it.
Flatpak: the sandbox needs `--talk-name=org.a11y.Bus`. snap: there is no
accessibility interface or plug to grant (`snap interface a11y` does not exist);
connect `desktop-legacy` or `unity7`. The adapter's own error for a missing or
hidden bus names both fixes. Neither fix is verified against a sandboxed app, so
an empty `list-apps` for a sandboxed app is a reason to check these first.
