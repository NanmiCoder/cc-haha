# Interaction Commands

Commands that change UI state. Run `agent-desktop <command> --help` for flags.

## Headless and headed

`--headed` is global (`agent-desktop --headed click @s8f3k2p9:e5`) and applies to every `batch` entry. A headed action may focus the exact source window first, and a pointer action needs a verified target point.

`press` is always physical keyboard input. `hover`, `drag`, `mouse-move`, `mouse-click` and `mouse-wheel` are physical cursor input and need `--headed`. Raw coordinates carry no window identity, so they never focus an app. `key-down`, `key-up`, `mouse-down` and `mouse-up` are reserved and never deliver input. They return `ACTION_NOT_SUPPORTED`, except that a headless `mouse-down` or `mouse-up` returns `POLICY_DENIED` first. Use `press`, `mouse-click` or `drag`.

Which gestures have a headless path:

| Command | Headless |
|---------|----------|
| `click`, `set-value`, `clear`, `select`, `check`, `uncheck`, `toggle`, `expand`, `collapse`, `scroll`, `scroll-to` | Yes, where the element advertises a semantic action (not `scroll` on Linux) |
| `type`, `right-click`, `focus` | OS-dependent. Read the platform skill for which need `--headed` |
| `double-click`, `triple-click`, `hover`, `drag`, `mouse-*` | No. They need `--headed` |

Native cross-app drag and drop may not start from synthetic events. It works for same-view drags and for web drag and drop.

## Read the result

A successful action reports what happened, not only that it ran.

| Field | Meaning |
|-------|---------|
| `data.steps` | Each mechanism tried, in order: `label`, `outcome` (`attempted`, `skipped`, `succeeded`), `mechanism` (`semantic_api` or `physical_synthetic`), `verified` |
| `data.disposition.delivery` | `delivered_verified` when the effect was observed, `delivered_unverified` when the app claimed success without an observable change |
| `data.post_state` | The target's state after the action, when it has one |
| `data.surfaces` | Overlays open once the action settled |

Stateful actions (`set-value`, `type`, `clear`, `check`, `uncheck`, `toggle`, `expand`, `collapse`) re-read state after they run. A readable contradiction returns `ACTION_FAILED` with `details.kind: "post_action_verification"`. A failed read keeps its own error code, so even `STALE_REF` or `TIMEOUT` can follow delivery. An unreadable postcondition does not fail the action. Missing evidence alone returns success with `delivered_unverified`, `details.verification_scope: "unavailable"` and `verification_reason: "insufficient_evidence"`.

- Secure text is redacted. A delivered write can return `delivered_unverified` with `verification_reason: "secure_field"`. This never turns a native delivery error into success.
- `set-value` and `type` verify the element value only (`verification_scope: element_value`, `application_commit: not_verified`). Confirm document-level effects, such as a table that should have resized, with an independent read.
- If `data.surfaces` lists a sheet, menu or alert, the app is waiting on it. Use `find --surface sheet` and answer it. A `delivered_unverified` result with an open surface usually means a confirmation is pending.

## Errors

Exit codes: `0` success, `1` structured error, `2` argument error. The `error` object can carry `details`, `recovery` and `disposition`. Ignore unknown keys.

| Code | Meaning | Recovery |
|------|---------|----------|
| `PERM_DENIED` | A required OS permission is missing | Read the platform skill |
| `ELEMENT_NOT_FOUND` | Ref cannot be resolved in the live UI | Snapshot again |
| `STALE_REF` | Ref no longer matches the live UI | Snapshot again, use the new ref |
| `AMBIGUOUS_TARGET` | Several live elements match the old identity | Narrow with `find`, then use the new ref |
| `SNAPSHOT_NOT_FOUND` | Snapshot id missing or expired | Snapshot again |
| `APP_NOT_FOUND` | App not running | `launch` it |
| `WINDOW_NOT_FOUND` | No matching window | Check the name, use `list-windows` |
| `ACTION_FAILED` | Action rejected, blocked, or contradicted by the result | Read `error.details`. A `checks[]` report names the blocking check. After delivery, read `disposition.retry` and `details.post_state` |
| `ACTION_NOT_SUPPORTED` | Element cannot do this | Use another command |
| `POLICY_DENIED` | A physical or headed path was blocked | Add `--headed` if physical input is intended. A dangerous key combo needs `--force` |
| `APP_UNRESPONSIVE` | A liveness probe also failed after an uncertain mutation | Take a fresh snapshot. Wait for recovery before you retry |
| `TIMEOUT` | Wait or actionability condition not met | Read `error.details.kind` |
| `INVALID_ARGS` | Bad arguments, or a protected system process was targeted for close | Check syntax |
| `PLATFORM_NOT_SUPPORTED` | The adapter lacks this method or surface | Use another approach |
| `NOTIFICATION_NOT_FOUND` | Notification index or fingerprint no longer matches | List again |
| `INTERNAL` | Unexpected OS failure | Read `message`. Retry once only if `disposition.retry` is `safe` |

`TIMEOUT` `details.kind` values: `actionability_timeout` (the target never became actionable), `wait_timeout` (a `wait` condition; carries `predicate`, `timeout_ms`, `last_observed` or `last_error`), `chain_deadline` (an activation chain ran out of time; carries `value_before`, `value_at_timeout`, `target`, `mutated`). With `chain_deadline`, `mutated: true` or an unknown expanded state means re-read before you retry. `mutated: false` means a direct retry is safe.

## Actionability

Before a ref action dispatches, core checks the target under one bounded budget. `--timeout-ms` (default 5000) sets that budget. For `drag`, the same deadline also covers pickup, movement, drop delay and completion; gesture time is not added to it. The checks are `visible`, `stable`, `enabled`, `supported_action`, `policy`, `editable`, and `receives_events` for pointer delivery. Each is `pass`, `fail` or `unknown`. The full report is in `error.details`: `{ "actionable": false, "checks": [ { "check", "status", "reason" } ] }`.

- Transient checks (`visible`, `stable`, `enabled`, `receives_events`) are polled about every 100 ms until they pass. On expiry the result is `TIMEOUT` or `ACTION_FAILED`.
- A disabled target waits out the whole budget and ends `TIMEOUT` with `kind: actionability_timeout`; its `last_report` carries the failed `enabled` check. A target that is also off screen is not scrolled while it stays disabled, so the result does not depend on where the page was scrolled.
- A ref that matches nothing on a complete live read waits the whole budget and ends `STALE_REF` (`AMBIGUOUS_TARGET` if several match), not `TIMEOUT`. A `hover` or `drag` wait that ends on such a settled ref names that code too.
- Terminal checks (`supported_action`, `policy`, `editable`) cannot be healed by waiting. They fail at once with `ACTION_NOT_SUPPORTED` or `POLICY_DENIED`.
- `hover` and each ref endpoint of `drag` use a pointer resolver: live visibility and bounds, one scroll-into-view try, a second equal-bounds sample, then `receives_events`. They do not need an element action.
- `receives_events` runs only when the action reaches the target by pointer: a headed action, `hover`, `drag`, or a click with no semantic delivery. A headless click that dispatches by a semantic action skips it.
- `receives_events` fails with `reason: "occluded by <role>"` and an `occluder` of `{ role, name, bounds }` when another element is on top. Bring the target window to the front or dismiss the occluder, then retry. A blind retry fails the same way.
- `receives_events` fails open. An inconclusive hit test reports `unknown` and the action dispatches. A passing check is not proof that nothing covered the target.
- `details.kind: "live_read_incomplete"` with `retryable: false` means native reads failed on every poll. Take a fresh snapshot and use a fresh ref.
- Pick recovery from the failing check's `reason`: `wait --element <ref> --predicate actionable`, a fresh snapshot, or `--headed` when `policy` failed and physical input is intended.

Standard ref actions try a scroll into view first. If no scrollable ancestor exists, the result is `ACTION_FAILED` with `details.kind: "scroll_into_view_unsupported"` and `retryable: false`. Scroll the containing viewport with `scroll` instead. A scroll that may have moved but could not be confirmed carries `delivered_unverified`. Re-read the element before you assume no effect.

## Click

```bash
agent-desktop click @s8f3k2p9:e5
agent-desktop --headed double-click @s8f3k2p9:e3
agent-desktop --headed triple-click @s8f3k2p9:e2
agent-desktop right-click @s8f3k2p9:e5
```

- `click` is the primary activation. Headless uses the activation the element publishes. `--headed` clicks physically first where that is possible and reports `physical_synthetic` in `data.steps`. The app is observed to judge delivery, not the accessibility return code.
- `double-click` and `triple-click` are physical gestures and fail closed headless. For raw coordinates use `--headed mouse-click --xy X,Y --count 2` (or `3`).
- `right-click` opens the context menu. Then take `snapshot --surface menu`. Use `select` for combo boxes and menu buttons instead.
- A right-click can return `APP_UNRESPONSIVE` with uncertain delivery after a modal menu opened. Look at the effect first. Do not retry.

## Text input

```bash
agent-desktop type @s8f3k2p9:e2 "hello@example.com"
agent-desktop type @s8f3k2p9:e2 "hello world" --interval-ms 60
agent-desktop set-value @s8f3k2p9:e2 "new value"
agent-desktop clear @s8f3k2p9:e2
agent-desktop focus @s8f3k2p9:e2
```

- `type` inserts text and checks the result when value and selection are readable. A readable mismatch returns `ACTION_FAILED`, and an unreadable result succeeds as `delivered_unverified`. Text sent as keystrokes reaches the field through the app's event queue, so the check re-reads the field while it changes, inside the `--timeout-ms` budget. If it settles on other text, or never settles, the result is `delivered_unverified` with `verification_reason: postcondition_mismatch`. Headed typing that focuses an inactive field can change the selection, and the result then stays unverified. Read the field with `get` before you write again.
- The default `--timeout-ms` of `type` is 5000 plus 30 ms per character of the text. An explicit `--timeout-ms` wins.
- `type --interval-ms N` (1 to 2000) types one keystroke every N ms inside one command; `--timeout-ms` then applies to each keystroke, and `0` makes each keystroke try once. A keystroke keeps combining marks, emoji sequences and CR LF together. The first keystroke is a full ref action (headed, it also focuses the window), and the rest go to the same element, taking the interaction lease one keystroke at a time. A headed keystroke is posted only while the target's process and focused element are unchanged; if focus moves, the burst stops with an error. The result adds `keystrokes` and `interval_ms`, and `post_state` is the field after the last keystroke. It stays `delivered_verified` only when that read shows the whole text; otherwise it is `delivered_unverified` with `verification_reason` `postcondition_mismatch`, `insufficient_evidence` (typed part way through the field) or `final_read_failed` (no `post_state`). `--wait-for` waits once, after the last keystroke. A failure part way through adds `details.typed_keystrokes` and `details.keystrokes` and is `delivered_unverified`: read the field before you type again.
- `set-value` writes the value directly through the semantic value path. It is faster than `type`, but it may not fire every UI callback. Use it for text fields, text areas and sliders.
- A cell that exposes no value write is not directly editable. Activate it, take a fresh snapshot, and target the editor that appears. Some apps expose no editor and accept only keyboard input.
- `clear` empties the element. `focus` sets keyboard focus without clicking.

For a shared editor, such as a spreadsheet cell, the edit is a sequence: activate the cell, snapshot, target the editor, write, then commit. Run the whole sequence from one writer. The interaction lease serializes single actions, not your sequence.

## Selection, toggle, expand

```bash
agent-desktop select @s8f3k2p9:e4 "Option B"
agent-desktop check @s8f3k2p9:e6
agent-desktop toggle @s8f3k2p9:e6
agent-desktop expand @s8f3k2p9:e7
```

- `select` picks an option by display text in a list, dropdown or combobox. For menu-backed controls it opens the menu, activates the item and checks the control value. A missing item or an unchanged value returns a structured error.
- `check` and `uncheck` are idempotent and verify the final state. Prefer them over `toggle`. Use `toggle` only when the current state is unknown, and it needs readable before and after state.
- `expand` and `collapse` act on disclosure triangles, tree items and accordions, and verify the final state.

## Scroll

```bash
agent-desktop scroll @s8f3k2p9:e1 --direction down --amount 3
agent-desktop scroll-to @s8f3k2p9:e8
```

- `scroll` moves a scroll area. Headless uses native scroll paths, but on Linux `scroll` is physical wheel input and needs `--headed` and X11 (see the Linux skill). Headed sends a physical wheel gesture where possible. With no safe mechanism it returns a structured error.
- `scroll-to` brings an element into view. Success means a re-read found it visible. It needs a ref. When only `bounds` exist, scroll the container with `scroll` or use `--headed mouse-wheel`.
- `mouse-wheel --x --y [--dx] [--dy]` posts a raw wheel event at a screen point. Use it for canvases and custom scroll surfaces with no accessibility scroll action.

## Keyboard

```bash
agent-desktop press return
agent-desktop press ctrl+shift+z
agent-desktop press cmd+s --app "TextEdit" --wait-for "button:Save" --wait-timeout 5000
```

- Key names: `return`, `escape`, `tab`, `space`, `delete`, `up`, `down`, `left`, `right`, `f1` to `f12`. Modifiers: `cmd`/`meta`, `ctrl`, `alt`, `shift`, joined with `+`. Modifier names and blocked combos differ by OS. Read the platform skill.
- A bare uppercase letter adds Shift: `press H` sends `shift+h`.
- `--app` or `--window-id` targets one app. Use `--window-id` when several instances share a name and `--app` alone is `AMBIGUOUS_TARGET`. Unscoped `press` goes to the foreground app.
- `press` reports `delivered_unverified`, because delivery does not prove the shortcut did its job. Wait for the expected effect once with `--wait-for` or `--wait-for-gone`. A timeout keeps the delivered result and is unsafe to retry blindly.
- To open a window with a shortcut, keep the press and the wait in one `batch`, so the baseline is taken before delivery: `press`, then `wait --event window-opened`. A failed wait does not make the press safe to repeat.
- Dangerous shortcuts are refused with `POLICY_DENIED` by the adapter. `--force` sends one anyway. Adding a modifier to a blocked shortcut usually gives another blocked one.

## `--wait-for` and `--wait-for-gone`

Global flags that poll the tree until a selector matches (or stops matching) and then return a snapshot envelope.

```bash
agent-desktop snapshot --app Finder -w "button:OK"
agent-desktop click @s8f3k2p9:e5 -w ":Saved!"
agent-desktop click @s8f3k2p9:e5 --wait-for-gone "progressindicator" --wait-timeout 5000
```

- The selector is `role:text`, split on the first `:`. `"button"` is role only. `":Saved!"` is text only. Text searches name, value and description.
- They work on `snapshot`, `press` and every ref action. Other commands (`find`, `launch`, ...) return `INVALID_ARGS`. `--root` cannot combine with them. Batch entries never inherit an outer `-w`.
- `--wait-timeout` defaults to 30000. On expiry: exit `1`, `TIMEOUT`, `details.kind: "wait_timeout"`, `details.snapshot_id` of the last tree. A post-action timeout also embeds `details.after_action`.
- A ref action polls the acted-on ref's window. The action result is kept under `after_action`.
- `--wait-for-gone` succeeds with `{ "gone": true, "target_absent": true }` when the app or window itself closed.
- For `drag`, `--wait-for-scope to|from` picks which endpoint window to poll (default `to`).

## Mouse

```bash
agent-desktop --headed hover @s8f3k2p9:e5
agent-desktop --headed drag --from @s8f3k2p9:e1 --to @s8f3k2p9:e5
agent-desktop --headed drag --from-xy 100,200 --to-xy 400,500 --drop-delay 800
agent-desktop --headed mouse-click --xy 500,300 --count 2
agent-desktop --headed mouse-move --xy 100,200
```

- `hover` moves the cursor to an element center or to `--xy`. A positive `--duration` is rejected, because a stateless process cannot own the cursor during a dwell. Hover, then `wait <ms>`.
- With `--headed`, a ref endpoint must focus its exact window first. If focus cannot be confirmed, the command fails before delivery. Coordinate-only input never focuses.
- `drag` accepts refs, coordinates, or a mix. The destination app is never pre-focused, because raising it could cover the source point. For a cross-app drag, keep the destination visible. Both endpoints still pass visibility, stability and hit-test checks.
- `drag --timeout-ms` covers the whole gesture as well as target preparation. An explicit `--duration` plus `--drop-delay` at or above the budget returns `INVALID_ARGS` before target work. Leave additional room for platform pickup/default delays, resolution and completion: for a 5000 ms movement, use `--duration 5000 --timeout-ms 10000`. A valid request can still return `TIMEOUT` if preparation consumes the remaining gesture budget. Optional `--wait-for`/`--wait-for-gone` verification has its own separate wait budget.
- A drop target often needs the item to dwell over it. The default `--drop-delay` is 500 ms (150 ms on Linux, where a longer hold opens a hovered Files folder). Raise it (800 to 1200) for list reorders and cross-window drops.
- `mouse-click` takes `--button left|right|middle`, `--count`, and `--modifiers`.

## Choose the command

| Goal | Use | Fall back to |
|------|-----|--------------|
| Click a button | `click @ref` | `--headed mouse-click --xy X,Y` |
| Fill a text field | `set-value @ref "text"` | `clear` then `type` |
| Set a checkbox | `check` / `uncheck` | `toggle` when state is unknown |
| Pick a dropdown option | `select @ref "Option"` | open the menu, then `snapshot --surface menu` |
| Open a context menu | `right-click @ref` | `--headed mouse-click --button right` |
| Move between fields | `press tab` | `focus @ref` |
| Copy text out of a field | `get @ref --property value` | `press` the copy shortcut, then `clipboard-get` |
| Find an off-screen item | `scroll @area`, then `find` | `scroll-to @ref` |

## Agent cursor

A visible cursor overlay is optional presentation. Enable it once per session (see `commands-system.md`). It shows where each action lands and never changes what the action does.
