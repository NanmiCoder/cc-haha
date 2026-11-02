# Error handling

The FFI uses an errno-style last-error pattern. Every `AdResult`-returning
function returns `AD_RESULT_OK` (= 0) on success or a negative error
code on failure. When a failure occurs, thread-local last-error state is
populated; read it with the `ad_last_error_*` accessors.

## Minimal pattern

```c
AdExactWindowInfo win;
AdResult rc = ad_launch_app_exact(adapter, "com.apple.finder", 5000, &win);
if (rc != AD_RESULT_OK) {
    const char *msg = ad_last_error_message();
    const char *sug = ad_last_error_suggestion();   // may be NULL
    fprintf(stderr, "launch_app failed (%d): %s\n", (int)rc, msg ? msg : "(no message)");
    if (sug) fprintf(stderr, "  suggestion: %s\n", sug);
    // no need to release the struct: out-param was zero-initialized
    return -1;
}
// ...use win...
ad_release_exact_window_fields(&win);
```

## Last-error accessors

Six accessors read the calling thread's last-error slot. The first five share
the per-thread lifetime contract below. `ad_last_error_delivery_semantics`
copies plain values into caller storage, so no pointer lifetime applies:

| Accessor                        | Returns                                                        |
|---------------------------------|----------------------------------------------------------------|
| `ad_last_error_code()`          | The `AdResult` code of the last failure, or `AD_RESULT_OK`    |
| `ad_last_error_message()`       | Human-readable description, or null                            |
| `ad_last_error_suggestion()`    | Recovery hint, or null                                         |
| `ad_last_error_platform_detail()` | OS-specific diagnostic (AX codes, HRESULTs, AT-SPI), or null |
| `ad_last_error_details()`       | Structured JSON details, or null: **sensitive** (see below)   |
| `ad_last_error_delivery_semantics(&sem)` | Writes `AdDeliverySemantics {delivery, retry}` for the last failure and returns `AD_RESULT_OK`; both fields are `UNKNOWN` (0) when no error is recorded. A null `sem` returns `AD_RESULT_ERR_INVALID_ARGS`. Reading does not clear or replace the slot. |

`delivery` is an `AdDeliveryDisposition`: `AD_DELIVERY_DISPOSITION_UNKNOWN` (0),
`_NOT_DELIVERED` (1), `_DELIVERY_UNCERTAIN` (2), `_DELIVERED_UNVERIFIED` (3),
`_DELIVERED_VERIFIED` (4). `retry` is an `AdRetryDisposition`:
`AD_RETRY_DISPOSITION_UNKNOWN` (0), `_SAFE` (1), `_UNSAFE` (2). Retry only on
`_SAFE`.

`ad_last_error_details()` returns a JSON string with structured context:
the actionability check report on `ACTION_FAILED`, candidate element
summaries on `AMBIGUOUS_TARGET`, the last observed state on a `wait`
`TIMEOUT`, etc. The details may contain element names, values, and window
titles from the user's screen. Treat as sensitive diagnostics and avoid
routing to shared log surfaces.

## Lifetime contract

The pointer returned by any `ad_last_error_*` accessor stays valid across
any number of later **successful** FFI calls. Only the next **failing** call
rotates the slot, as with POSIX `errno` and `strerror`.

```c
AdResult rc = ad_some_call(...);
const char *msg = ad_last_error_message();   // snapshot

ad_check_permissions(adapter);                // success
ad_check_permissions(adapter);                // success
printf("%s\n", msg);                          // still valid
```

After a later failure the earlier pointer may dangle, so read it before the
next call that can fail. Last-error is thread-local: a failure on one thread
does not touch another thread's slot.

`ad_check_permissions` does not treat `Unknown` as success. Stub adapters
that cannot answer permission probes return
`AD_RESULT_ERR_PLATFORM_NOT_SUPPORTED`. The macOS adapter reports
`AD_RESULT_ERR_INTERNAL` only if the platform probe itself is ambiguous;
read `ad_last_error_*` for the diagnostic.

## Error codes

Numeric values are ABI-stable. New codes are appended, and existing values
are never renumbered. Handle values outside this list, because a later
release may add codes.

| Name                                  | i32   | Meaning                                    |
|---------------------------------------|-------|--------------------------------------------|
| `AD_RESULT_OK`                        |   0   | Success                                    |
| `AD_RESULT_ERR_PERM_DENIED`           |  -1   | Accessibility / input permission missing   |
| `AD_RESULT_ERR_ELEMENT_NOT_FOUND`     |  -2   | Ref resolve / find miss                    |
| `AD_RESULT_ERR_APP_NOT_FOUND`         |  -3   | Bundle/PID lookup miss                     |
| `AD_RESULT_ERR_ACTION_FAILED`         |  -4   | Action dispatched but rejected             |
| `AD_RESULT_ERR_ACTION_NOT_SUPPORTED`  |  -5   | Platform cannot perform this action        |
| `AD_RESULT_ERR_STALE_REF`             |  -6   | Ref predates a UI change; re-snapshot      |
| `AD_RESULT_ERR_WINDOW_NOT_FOUND`      |  -7   | Window filter matched nothing              |
| `AD_RESULT_ERR_PLATFORM_NOT_SUPPORTED`|  -8   | API unavailable on this OS                 |
| `AD_RESULT_ERR_TIMEOUT`               |  -9   | Wait exceeded deadline                     |
| `AD_RESULT_ERR_INVALID_ARGS`          | -10   | Null pointer, bad enum, invalid UTF-8      |
| `AD_RESULT_ERR_NOTIFICATION_NOT_FOUND`| -11   | Notification index out of range or reordered |
| `AD_RESULT_ERR_INTERNAL`              | -12   | Internal failure or caught Rust panic      |
| `AD_RESULT_ERR_SNAPSHOT_NOT_FOUND`    | -13   | Requested snapshot ref store is missing    |
| `AD_RESULT_ERR_POLICY_DENIED`         | -14   | Current action policy blocks this fallback |
| `AD_RESULT_ERR_AMBIGUOUS_TARGET`      | -15   | Strict re-identification found multiple candidates; re-snapshot |
| `AD_RESULT_ERR_APP_UNRESPONSIVE`      | -16   | Read-only liveness probe failed after an uncertain mutation |

## Ref token validation

Ref-taking entrypoints accept one canonical form:

- `@<snapshot_id>:e<N>` is a qualified ref. It embeds its snapshot ID.

A bare `@e<N>` ref is not accepted.

`N` is a positive `u32` written without a sign and with at most 10 decimal
digits. Snapshot IDs are 3–64 ASCII alphanumeric, `-`, or `_` characters.
Malformed tokens, invalid UTF-8, or a bare ref return `AD_RESULT_ERR_INVALID_ARGS` before
dispatch. A well-formed token whose saved snapshot is absent returns
`AD_RESULT_ERR_SNAPSHOT_NOT_FOUND`; a saved snapshot with no matching local ref
returns `AD_RESULT_ERR_STALE_REF`.

Snapshot lookup is confined to the adapter's namespace. An adapter created with
`ad_adapter_create_with_session` never searches the global namespace or another
session for a matching snapshot ID.

## Off-main-thread migration

Since ABI v3, adapter entrypoints run on any host thread, including off the
macOS main thread, so `AD_RESULT_ERR_INTERNAL` is never an off-main-thread
result. Native handles stay thread-affine: use from another thread or adapter,
or after release or revocation, returns `AD_RESULT_ERR_INVALID_ARGS`. See
[threading.md](threading.md) for the concurrency and ownership contract.

## Enum validation

Every `#[repr(i32)]` enum field is validated at the C boundary. An
out-of-range discriminant returns `AD_RESULT_ERR_INVALID_ARGS` with a
last-error diagnostic, instead of undefined behavior. Validated fields: `AdAction.kind` (`AdActionKind`),
`AdMouseEvent.kind` (`AdMouseEventKind`), `AdMouseEvent.button`
(`AdMouseButton`), `AdScrollParams.direction` (`AdDirection`),
`AdTreeOptions.surface` (`AdSnapshotSurface`), `AdScreenshotTarget.kind`
(`AdScreenshotKind`), `AdWindowOp.kind` (`AdWindowOpKind`), and the
`policy` parameter of `ad_execute_by_ref` / `ad_execute_action_with_policy`
/ `ad_execute_ref_action_exact_with_policy` (`AdPolicyKind`).

## Command-backed JSON entrypoints: dual-failure modes

`ad_snapshot`, `ad_execute_by_ref`, `ad_execute_by_ref_timeout`, `ad_wait`,
`ad_status`, `ad_version`, `ad_trace_show`, and `ad_trace_export` have two
distinct failure modes:

- **Argument / infrastructure failure** (null adapter, invalid UTF-8,
  bad discriminant, context error): `*out` is set to null,
  no allocation is made, and the last-error slot is the only failure
  indication.
- **Command-level failure** (app not found, STALE_REF, TIMEOUT, etc.):
  `*out` is set to a heap-allocated JSON string with `"ok":false` and an
  `"error"` payload. The caller **must still free** it with
  `ad_free_string(*out)`. The last-error slot is also set.

Always check `*out` for null before deciding whether to free.

## Panic safety

Every `extern "C"` entrypoint that can panic wraps its body in `catch_unwind`. A Rust panic
inside the FFI surfaces as `AD_RESULT_ERR_INTERNAL` with the message
`"rust panic in FFI boundary"`, not a host crash. This holds only for a cdylib
built with the `release-ffi` profile, because the workspace `release` profile
uses `panic = "abort"`.
