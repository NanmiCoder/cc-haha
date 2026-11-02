# agent-desktop-ffi

C-ABI cdylib over [`PlatformAdapter`](../../crates/core/src/adapter/mod.rs). Exposes
`libagent_desktop_ffi.{dylib,so,dll}` to Python (ctypes), Swift, Go (cgo),
Node (ffi-napi), and C++ consumers without spawning a CLI subprocess per call.

## Build

```bash
cargo build --profile release-ffi -p agent-desktop-ffi
```

The `release-ffi` profile keeps `panic = "unwind"`, which is required for the
`catch_unwind` traps that prevent panics from crossing the `extern "C"` boundary.
Do **not** use `--release` — that profile sets `panic = "abort"`, which silently
defeats every trap.

For the CI / stub-adapter path (no AX permission required):

```bash
cargo build --profile release-ffi -p agent-desktop-ffi --features stub-adapter
```

`--features stub-adapter` replaces the real platform adapter with a no-op that
returns `PLATFORM_NOT_SUPPORTED` for every adapter call.

## ABI Surface

| Group | Key symbols |
|-------|-------------|
| ABI handshake | `ad_abi_version()`, `ad_init(expected_major)` |
| Adapter lifecycle | `ad_adapter_create()`, `ad_adapter_create_with_session(id)`, `ad_adapter_destroy()` |
| Command-backed JSON entrypoints | `ad_snapshot`, `ad_execute_by_ref`, `ad_execute_by_ref_timeout`, `ad_wait`, `ad_version`, `ad_status`, `ad_trace_show`, `ad_trace_export` |
| Log callback | `ad_set_log_callback(fn(level, msg))` — unstructured tracing to a callback |
| Structured file trace | Same JSONL contract as CLI, gated by a `trace: on` session manifest (no ABI change); use `session start` before creating a session adapter |
| Errno last-error | `ad_last_error_code()`, `ad_last_error_message()`, `ad_last_error_suggestion()`, `ad_last_error_platform_detail()` |
| Type accessors / size getters | `ad_*_size()`, `ad_*_list_{count,get,free}()`, `ad_image_buffer_*()` |
| Free helpers | `ad_free_string()`, `ad_free_handle()`, `ad_free_tree()`, `ad_free_action_result()` |

The full declaration list is in [`include/agent_desktop.h`](include/agent_desktop.h).
Consumers must call `ad_init(AD_ABI_VERSION_MAJOR)` after `dlopen` to verify the
loaded dylib matches the header the consumer was built against.

Direct window, surface and ref targeting takes the versioned
`AdExactRefEntry`, `AdExactWindowInfo`, and `AdExactSurfaceInfo` structs, which
carry the process generation and surface ID of the observed identity.
ABI 6 and `AD_EXACT_REF_ENTRY_VERSION` 2 add `bounds_space` to `AdRefGeometry`,
inside `AdExactRefEntry`: an `AD_BOUNDS_SPACE_*` constant naming the frame of
`bounds`, screen-relative on macOS and Windows and window-relative on Linux.
`ad_execute_by_ref` and `ad_wait` accept only snapshot-qualified refs
(`@<snapshot_id>:eN`).

## Command wrappers

Each command-backed JSON entrypoint has one canonical module under
`src/commands/`. The build script only configures the dylib install name and
never rewrites source files.

## Thread Safety (macOS)

Adapter entrypoints may run on any host thread. AX and CG calls have no blanket
main-thread restriction, and Apple explicitly documents
[`NSWorkspace.shared`](https://developer.apple.com/documentation/appkit/nsworkspace/shared)
as safe from any thread. Cocoa-backed paths establish per-thread autorelease
pools; FFI initialization starts one `NSThread` once so Cocoa enables the locks
Apple documents for POSIX-threaded hosts.

Native handles are stricter: resolve, use, and free each handle on the same
thread with the same adapter. Mutations are serialized across processes by the
canonical interaction lease. See the FFI skill's threading reference for the
full evidence and ordering contract.

## Error Model

Every `AdResult`-returning function sets thread-local last-error state on failure.
Read it with `ad_last_error_code()` / `ad_last_error_message()` /
`ad_last_error_suggestion()`. The pointer returned by `ad_last_error_message()`
stays valid until the next *failing* call on the same thread — successful calls
leave it untouched (POSIX errno semantics).

## Full Documentation

`skills/agent-desktop-ffi/` — build-and-link guide, ownership model, threading
rules, and error-handling patterns.
