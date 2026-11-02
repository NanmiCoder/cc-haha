# macOS troubleshooting

Each entry is a symptom, its cause, and the fix. Read `error.code`, `error.suggestion` and `error.disposition` in the JSON envelope first.

## PERM_DENIED

**Symptom.** A command returns `PERM_DENIED`, or `permissions` shows `denied`.

**Cause.** The app that launched agent-desktop has no Accessibility permission (or Screen Recording, for `screenshot` and `session start --screenshots`). The grant belongs to the launching app, not to the shell. A new launcher, such as a different terminal or an IDE, needs its own grant.

**Fix.** Follow "First contact" in the macOS skill: `permissions --guide`, turn on the launching app (and the `agent-desktop` binary if it is listed on its own) in System Settings > Privacy & Security > Accessibility or Screen Recording, then run `agent-desktop permissions` to confirm `granted`. The launching app does not need a restart.

The guide offers the app bundle of the nearest process above agent-desktop. Under a tmux server or an SSH session, no such app exists, so the guide offers the `agent-desktop` binary. In that case, add the terminal app that started tmux by hand. macOS 27 and later name the Accessibility list Device Control and Data Access.

For Automation, open Privacy & Security > Automation and allow the launching app to control System Events.

## Empty or sparse tree

**Symptom.** `snapshot` returns few nodes, or no refs.

**Cause.** Some apps expose little accessibility data: custom-rendered UIs, games, some creative tools, and parts of web views. Chromium and Electron apps need web accessibility enabled in the renderer.

**Fix.**
1. Check permissions first (see PERM_DENIED).
2. Remove `-i` to see non-interactive nodes. Raise `--max-depth`.
3. Run `list-surfaces --app "App"`. The content may sit in a sheet, popover or menu surface.
4. Retry the snapshot once. A renderer needs a short settle time after accessibility is enabled.
5. Use `screenshot` as a visual fallback (needs Screen Recording).
6. For a fresh Chromium app, use `launch "App" --cdp` and a CDP client for the web contents.

## Slow or truncated snapshot

**Symptom.** A snapshot is slow, or returns `"complete": false` with `"truncated": true`.

**Cause.** Large apps (Xcode, Safari with many tabs) have deep trees. A truncated snapshot ran out of its observation budget.

**Fix.** Use `find` when you know the target. Otherwise use `snapshot --skeleton -i --compact`, then `snapshot --root @<snapshot_id>:eN` to drill down. Add `--window-id` to limit the window.

## ACTION_FAILED

**Symptom.** A ref action returns `ACTION_FAILED`.

**Cause.** The element is disabled, the app is busy, or the element does not support the action. The semantic chain tries only the actions the element advertises, then stops.

**Fix.**
1. Run `is @ref --property enabled`. Wait or fix the state if it is false.
2. Run `get @ref --property bounds` and check that the element is on screen.
3. If physical input is right for the task, retry with `--headed`.
4. As a last step, use the keyboard: `focus @ref`, then `press return`.

## POLICY_DENIED

**Symptom.** A command returns `POLICY_DENIED`.

**Cause.** The semantic path could not finish, and the physical path is blocked because the command ran headless. Hover, drag, double-click, triple-click and cursor-moving mouse commands always need `--headed`. Coordinate `right-click` is also blocked headless.

**Fix.** Add the global `--headed` flag only if physical input is what you want. Example: `agent-desktop --headed mouse-click --xy 640,400 --button right`. Take coordinates from `get @ref --property bounds`.

## APP_UNRESPONSIVE after right-click

**Symptom.** `right-click` returns `APP_UNRESPONSIVE` with `delivery_uncertain` and `retry: unsafe`.

**Cause.** `AXShowMenu` can enter modal menu tracking and return `kAXErrorCannotComplete` after the menu opened.

**Fix.** Do not retry. Run `snapshot --app "App" --surface menu -i`. If the menu is there, use it. If not, run `list-surfaces --app "App"`. For a combo box or menu button, use `select @ref "Option"`.

## select does not find the menu

**Symptom.** `select` fails to confirm the choice.

**Cause.** `select` proves success by a closed-to-open menu change. An already open menu hides that change.

**Fix.** Dismiss the open menu with `press escape`, then run `select` again.

## APP_NOT_FOUND or WINDOW_NOT_FOUND

**Fix.** Run `agent-desktop launch "App Name"` (display name or bundle ID). Then run `list-windows --app "App"`. A full-screen app still appears in `list-windows`, but its bounds equal the screen and its state can lag behind animations, so use `wait`.

## Notification Center

| Symptom | Cause | Fix |
|---|---|---|
| `POLICY_DENIED` when listing: the center is closed | The command is headless and cannot open the center | Add `--headed`, or open the center yourself |
| `dismiss-notification` returns `ACTION_FAILED` | No dismiss path worked on that item | See the chain below, then list again |
| `NOTIFICATION_NOT_FOUND` | The index moved after a dismiss | Run `list-notifications` again |
| Banner gone before you list it | Banners are transient | Use `wait --notification --app "App"` |
| A dismissed item is replaced by another | Notifications from one app are stacked | Dismiss again. `dismiss-all-notifications` may need more than one round |
| Calendar widget stays | It is a system widget, not a notification | Expected |

The dismiss chain runs in order: the `AXDismiss` and `AXRemoveFromParent` actions, then a close button named close, clear or dismiss, then hover to reveal a hidden close button and press it. `AXPress` is never used, because it opens the source app and does not dismiss.

## Keyboard shortcut does nothing

**Cause.** The shortcut used `ctrl` where macOS uses `cmd`, or the keys went to the wrong app.

**Fix.** Use `cmd+...`. To send keys to one app without focusing it, use `press cmd+s --app "App"`.
