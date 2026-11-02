# JSON output contract

Every command returns structured JSON:

```json
{
  "version": "2.5",
  "ok": true,
  "command": "click",
  "data": {
    "action": "click",
    "disposition": { "delivery": "delivered_unverified", "retry": "unsafe" }
  }
}
```

Errors include machine-readable codes and recovery hints:

```json
{
  "version": "2.5",
  "ok": false,
  "command": "click",
  "error": {
    "code": "STALE_REF",
    "message": "@s8f3k2p9:e7 not found in current RefMap",
    "suggestion": "Re-run a snapshot to obtain fresh refs, then retry with the new ref (CLI: snapshot [--skeleton]; FFI: ad_snapshot then pass the printed qualified ref to ad_execute_by_ref)",
    "recovery": {
      "strategy": "refresh_snapshot_then_retry_original",
      "retryable": true,
      "requires_fresh_snapshot": true
    },
    "disposition": {
      "delivery": "not_delivered",
      "retry": "safe"
    }
  }
}
```

`error.code`, `error.message` and `error.disposition` are always present. `suggestion`, `recovery`, `platform_detail` and `details` are omitted when empty. `recovery` appears only when `disposition.retry` is `safe`, and its `retry_after_ms` is set only for `TIMEOUT` and `APP_UNRESPONSIVE`.

Version 2.2 replaces the 2.1 `TIMEOUT` error for a budget-exhausted snapshot
with a successful, explicitly partial response, and adds `data.complete`.
Snapshot data always carries `complete`. A snapshot that runs out of budget now
returns `ok: true` with `"complete": false`, the tree it did observe,
`"truncated": true`, and `nodes_observed`, instead of a `TIMEOUT` error and no
tree. Every node whose descendants were cut short carries
`"subtree_truncated": true`, so a reader can walk from the root to each
boundary. Consumers must read `data.complete` to decide whether a tree is whole;
a `TIMEOUT` error no longer signals an oversized tree. A `--root` drill-down is
unaffected: it replaces refs inside an existing snapshot, so an incomplete
observation still returns `TIMEOUT` rather than a partial tree.

Version 2.1 replaces the 2.0 `error.retry_command` string with the structured
`error.recovery` object and adds `error.disposition`. Consumers must select a
recovery strategy from `recovery.strategy` only when `disposition.retry` is
`safe`; command strings from older envelopes must not be executed blindly.
The removed `retry_command` field has no compatibility alias.

## Disposition values

Every error carries `disposition`, and commands that act on a target may also
carry it on their result. `delivery` is one of `unknown`, `not_delivered`,
`delivery_uncertain`, `delivered_unverified` or `delivered_verified`. `retry`
is one of `unknown`, `safe` or `unsafe`, and it follows from `delivery`:
`not_delivered` is `safe`, and every other non-`unknown` value is `unsafe`.

`unknown` means the command established nothing about delivery. A failure of a
mutating command that carries no delivery evidence, such as a `TIMEOUT` on an
operation that may already have landed, keeps it. A read-only command sends
nothing and invalid arguments never reach the application, so their errors, and
a lookup failure such as `APP_NOT_FOUND`, carry `not_delivered`. Treat `unknown`
as not safe to retry automatically: read `error.code` and the message, and
choose a recovery strategy only when `disposition.retry` is `safe`.

## Version 2.4 migration

Stateful ref actions (`set-value`, `type`, `clear`, `check`, `uncheck`, `toggle`, `expand`, and `collapse`) now reject observed postcondition contradictions after one delivery attempt. Readback failures preserve the adapter's error code and carry `details.kind: "post_action_verification"`. Missing evidence alone remains a successful `delivered_unverified` result with `details.verification_scope: "unavailable"`; neither that result nor verified element state proves application-level persistence.

macOS mutation errors that do not prove non-delivery stop fallback chains with an unsafe retry disposition. This affects activation, selection, disclosure, scrolling, and window operations; an unchanged or unreadable state is not proof that a mutation was never delivered. Value-writing chains also stop after unverified delivery instead of applying a second mechanism. Failures after preparatory scrolling carry `details.preparatory_scroll`, which records that the view may have changed. Their retry disposition follows the failure: a refusal that sent nothing is `not_delivered` and safe to retry, and any other failure keeps its own disposition.

Inspect `disposition.retry` before retrying or choosing an alternative action, regardless of `error.code`. An error may include `post_state` and `postcondition_satisfied` without erasing the original execution failure. The same verification rules apply to FFI ref actions; the C ABI is unchanged. The Rust `ActionResult::from_execution` constructor now takes only action and steps and returns an infallible result; live verification belongs to `execute_verified_action`.

## Version 2.5 migration

Version 2.5 is a breaking payload change for the commands that dispatch pointer, drag, clipboard, app-close and window operations: `mouse-click`, `mouse-move`, `mouse-wheel`, `hover`, `drag`, `clipboard-set`, `clipboard-clear`, `close-app`, `move-window`, `resize-window`, `minimize`, `maximize` and `restore`.

The unconditional success flags are removed with no compatibility alias: `clicked`, `moved`, `scrolled`, `hovered`, `dragged`, `resized`, `minimized`, `maximized`, `restored`, `closed`, `cleared`, the `requested` field of `close-app`, and the inner `ok` of `clipboard-set`. A flag that every successful call carried proved nothing about the operation.

A verified window report names the exact readback in `details.verification_scope` (`window_size`, `window_position`, `window_minimized_state` or `window_maximized_state`). Geometry scopes also state `details.tolerance` and `details.units`: 2 points on macOS, 8 px on Windows, 2 pixels on Linux. A window failure after the write keeps its code, details and disposition and gains `details.target` and the completed `details.steps`.

Each of these commands now returns the adapter's own report inside `data`:

```json
{
  "action": "drag",
  "disposition": { "delivery": "delivered_unverified", "retry": "unsafe" },
  "steps": [ { "label": "pointer_drag", "outcome": "succeeded", "mechanism": "physical_synthetic" } ],
  "target": { "kind": "drag", "from": { "x": 10, "y": 20 }, "to": { "x": 80, "y": 20 } },
  "from": { "x": 10, "y": 20 },
  "to": { "x": 80, "y": 20 }
}
```

- `disposition.delivery` is `delivered_verified` only after the adapter read back the postcondition it names, `delivered_unverified` after a completed dispatch without that proof, and `not_delivered` only when the adapter observed that the operation was already satisfied (for example `close-app` on an application that had already exited). `ok: true` means the command returned a delivered or already-satisfied result, not that the application effect was verified.
- `target.kind` is `window` (`id`, `title`, `process`), `app` (`name`, `process`), `pointer` (`point`), `drag` (`from`, `to`) or `clipboard`. The adapter supplies the identity it validated and used. A pointer target is the dispatch coordinate and does not prove which application received the input.
- Request context (`x`, `y`, `count`, `dx`, `dy`, `width`, `height`, drag endpoints, `drop_delay_ms`, `type`, `app`, `method`, and a confirmed `focused`) keeps its earlier meaning. These fields echo the request and are not observed post-state.
- Errors keep `error.disposition`. A failed `--wait-for` after a delivered operation keeps the operation's own delivery (verified, unverified, or not delivered) in `error.disposition` and carries the report under `details.after_action`.
- The Rust `ActionResult` and `OperationReport` readers reject a payload without an explicit `disposition`; a missing disposition no longer reads back as delivered-unverified.
- The C ABI is unchanged. Status-only functions such as `ad_close_app` and `ad_drag` still cannot expose the disposition, steps or target of a successful call.

## Headed action verification

- Headed ref interactions activate the exact source app/window before final pointer hit testing. Read-only readiness polling must not prevent a background target from reaching that focus phase; final hit testing remains mandatory before delivery.
- Focus and preparatory scrolling can change coordinates. Stability is verified against fresh live observations, not by requiring coordinates to remain equal to the original snapshot.
- On macOS, post-activation focus confirmation uses fresh system-wide `AXFocusedApplication` and exact-window evidence with process-generation checks. A cached `NSWorkspace` foreground snapshot is not sufficient in a process that just activated another app.
- Focusing an inactive text field can change its selection. A pre-focus range cannot establish the expected insertion into a nonempty field; such a result is explicitly unverified rather than falsely contradicted.
- A settle-loop pacing budget does not replace the caller's deadline for native reads. Tests assert deadline identity rather than arbitrary remaining-time thresholds.

## Find result shape

`find` match objects report the element's actual accessibility `name`. Elements
without an accessible name omit `name` entirely; their content stays in `value`.
Earlier output synthesized a display name, falling back to `value` or
`description`, then a `(unnamed <role>)` placeholder, so consumers that treated
`name` as always present must tolerate its absence and apply their own fallback
to `role` or `value`.

## Error codes

| Code | Meaning |
|------|---------|
| `PERM_DENIED` | Accessibility permission not granted |
| `ELEMENT_NOT_FOUND` | No element matched the ref or query |
| `APP_NOT_FOUND` | Application not running or no windows; the lookup failed before anything was sent, so the disposition is `not_delivered` |
| `STALE_REF` | Ref could not be re-identified in the live UI |
| `AMBIGUOUS_TARGET` | Ref recovery matched multiple plausible targets |
| `SNAPSHOT_NOT_FOUND` | Snapshot ID is missing or expired |
| `POLICY_DENIED` | Physical/headed path blocked by policy |
| `ACTION_FAILED` | Action rejected, or its observed result contradicted the request |
| `ACTION_NOT_SUPPORTED` | The target does not expose the requested action |
| `APP_UNRESPONSIVE` | The matching application stopped responding |
| `PLATFORM_NOT_SUPPORTED` | Adapter method not implemented on this platform |
| `TIMEOUT` | Wait condition expired, or a live identity read stayed incomplete until the deadline |
| `INVALID_ARGS` | Invalid argument values |
| `WINDOW_NOT_FOUND` | The requested window does not exist, including a `screenshot --window-id` that matches no window; the disposition is `not_delivered` |
| `NOTIFICATION_NOT_FOUND` | The notification ID was not found |
| `INTERNAL` | Unexpected error or caught panic |

## Exit codes

`0` success, `1` structured error (JSON on stdout), `2` command-line parse error (the envelope is still printed, with `INVALID_ARGS`).
