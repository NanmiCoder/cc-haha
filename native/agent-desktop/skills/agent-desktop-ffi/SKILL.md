---
name: agent-desktop-ffi
tags: ffi, c-bindings, cdylib, python, swift, node, go, rust-ffi
requirements:
  - agent-desktop-ffi
description: >
  C-ABI bindings over agent-desktop's PlatformAdapter. Consumers
  (Python ctypes, Swift, Node ffi-napi, Go cgo, C++, Ruby fiddle)
  link libagent_desktop_ffi.{dylib,so,dll} and call `ad_*` functions
  directly instead of spawning the CLI binary per call. The canonical
  observe-act workflow is: ad_init → ad_adapter_create[_with_session]
  → ad_snapshot → read qualified refs (@s8f3k2p9:e5) → ad_execute_by_ref → ad_free_string
  → ad_adapter_destroy.
---

# agent-desktop-ffi

Direct C-ABI access to PlatformAdapter operations. Build the cdylib with the
`release-ffi` profile:

```sh
cargo build --profile release-ffi -p agent-desktop-ffi
```

The output is `target/release-ffi/libagent_desktop_ffi.dylib` (`.so` on Linux,
`agent_desktop_ffi.dll` on Windows) plus a committed C header at
`crates/ffi/include/agent_desktop.h`. The default `release` profile uses
`panic = "abort"`: a Rust panic inside an `extern "C"` function would `SIGABRT`
the host. `release-ffi` keeps `panic = "unwind"`, which the panic traps need.

Four reference topics, loaded as needed:

- [ownership.md](references/ownership.md): who allocates and who frees every
  pointer the FFI hands back.
- [error-handling.md](references/error-handling.md): errno-style last-error
  contract, error codes, enum validation, panic boundary.
- [threading.md](references/threading.md): host-thread contract, mutation
  ordering across threads and processes, adapter-bound native handles,
  AXIsProcessTrusted inheritance.
- [build-and-link.md](references/build-and-link.md): prebuilt archives, ABI
  handshake, struct size validation, C and Python examples.

## Observe-act workflow (canonical path)

```
ad_init(AD_ABI_VERSION_MAJOR)                    // verify header ↔ dylib match
adapter = ad_adapter_create_with_session("s1")   // or ad_adapter_create()
rc = ad_snapshot(adapter, "Finder", 0, 10, false, false, &json_out)
// parse json_out: locate snapshot-qualified refs in data.tree
ad_free_string(json_out)
// build action:
AdAction act = {0}; act.kind = AD_ACTION_KIND_CLICK;
rc = ad_execute_by_ref(adapter, "@s8f3k2p9:e5", &act, 0, &result_out)
ad_free_string(result_out)
ad_adapter_destroy(adapter)
```

`ad_snapshot` returns the CLI envelope `{version, ok, command, data}`.
`data.tree` carries snapshot-qualified refs for interactive elements. Read
`data.complete` before trusting a tree: `false` means the observation budget ran
out and the tree is partial, not an error. `ad_snapshot` always targets the
focused window of `app`; window targeting, skeleton mode and `--root` drill-down
are not exposed over the ABI. A bare `@eN` ref returns
`AD_RESULT_ERR_INVALID_ARGS`.

## Core constraints

- **ABI handshake.** Call `ad_init(AD_ABI_VERSION_MAJOR)` once after loading the
  library. A mismatch returns `AD_RESULT_ERR_INVALID_ARGS`: abort. `ad_abi_version()`
  returns the library's major for display. The major increments on a removed
  symbol or a layout change; new `ad_*` symbols and error codes are additive.
  Pin the exact `libagent_desktop_ffi` version you link against.

- **Session adapters.** `ad_adapter_create_with_session("session-id")` scopes
  refmap persistence to a session namespace, like CLI `--session <id>`. IDs are 1
  to 64 ASCII alphanumeric, `-`, or `_` characters. A null ID behaves like
  `ad_adapter_create()`. An invalid ID returns null (read `ad_last_error_*`).

- **Ref actions.** `ad_execute_by_ref` is the primary action entrypoint. It loads
  the RefStore, resolves the ref strictly (`STALE_REF` when the snapshot has no
  such ref or the element changed, `AMBIGUOUS_TARGET` on several candidates), runs
  the live actionability preflight (visible, stable, enabled, supported action,
  policy, editable), then dispatches. A disabled or unsupported target fails
  before any platform call; on `AD_RESULT_ERR_ACTION_FAILED` the check report is
  JSON in `ad_last_error_details()`. It auto-waits 5000 ms before the preflight;
  `ad_execute_by_ref_timeout` takes `timeout_ms` (`-1` = 5000 ms default, `0` =
  single-shot). `PressKey` defaults to `focus_fallback`; every other action,
  including `TypeText`, defaults to `headless`. Pass `AD_POLICY_KIND_FOCUS_FALLBACK`
  (1) to allow focus without cursor movement, or `AD_POLICY_KIND_HEADED` (2) to allow
  physical cursor and keyboard delivery. `ad_execute_ref_action_exact_with_policy`
  runs the same preflight from an `AdExactRefEntry`.

- **Generation-safe direct APIs.** Every direct targeting function takes
  process-generation evidence: `AdExactRefEntry`, `AdExactWindowInfo`,
  `ad_list_windows_exact`, `ad_launch_app_exact`, and the other `*_exact`
  symbols. `AdRefEntry`, `AdWindowInfo`, and `AdSurfaceInfo` exist
  only as fields embedded in the exact structs. `ad_list_surfaces_exact` keeps the
  surface `id`. From `AD_EXACT_SURFACE_INFO_VERSION` 2, `AdExactSurfaceInfo.unclassified`
  names the surface kinds its probe could not read (for example `sheet,menu`), or
  is null. A missing `sheet` or `menu` next to a listed kind is unknown, not
  absent. Only the Windows adapter fills it; macOS and Linux return null.

- **Native handles.** `ad_resolve_element_exact` and `ad_find_exact` return an
  `AdNativeHandle`. `ad_execute_action` (headless, no preflight) and
  `ad_execute_action_with_policy` act on it directly, bypassing the ref-action
  pipeline. Release every handle with `ad_free_handle(adapter, &handle)` on the
  same adapter and thread, before `ad_adapter_destroy`, on every platform. It
  zeroes `handle.ptr`, so a second call is a no-op.

- **Action results.** `AdActionResult.steps` mirrors the CLI `steps` array for
  activation-chain actions. Each `AdActionStep` has `label` and `outcome` strings,
  `mechanism` (`AD_STEP_MECHANISM_SEMANTIC_API` = 1 or
  `AD_STEP_MECHANISM_PHYSICAL_SYNTHETIC` = 2, valid only when `has_mechanism`),
  and `verified` (valid only when `has_verified`). `AdActionResult.disposition`
  carries the same delivery/retry pair as `ad_last_error_delivery_semantics`.
  Release the result with `ad_free_action_result(&out)`.

- **Display discovery.** Call `ad_list_displays` before using
  `AdScreenshotTarget.screen_index`. List order is the screenshot index order.
  Each `AdDisplayInfo` carries a stable display ID, bounds, primary flag, and scale.
  Release the list with `ad_display_list_free`.

- **Errors.** A failing call sets thread-local last-error state; read it with the
  `ad_last_error_*` accessors before the next failing call. `ad_last_error_details()`
  returns structured JSON (the actionability report on `ACTION_FAILED`, candidate
  summaries on `AMBIGUOUS_TARGET`) that can contain element names, values, and
  window titles from the user's screen: keep it out of shared logs.
  `ad_last_error_delivery_semantics` reports whether the failed action was
  delivered and whether a retry is safe. Invalid enum discriminants return
  `AD_RESULT_ERR_INVALID_ARGS`. See [error-handling.md](references/error-handling.md).

- **Threading.** Entrypoints may be called from any host thread. Native handles
  stay on the adapter and thread that created them; pass qualified refs across
  threads. Desktop mutations take the same cross-process interaction lease as the
  CLI; reads take no lease and carry finite deadlines. See
  [threading.md](references/threading.md) for the read/read, read/mutation, and
  mutation/mutation matrix.

- **Tracing.** File tracing (same JSONL contract as CLI `--trace`; segments carry
  `event`, `ts_ms`, `seq`, and redacted fields) is active only when the session has
  a manifest with `trace: on`, created by `session start` (or an equivalent manifest
  on disk) before the adapter is created. `ad_adapter_create_with_session` alone
  writes nothing. Each OS process appends to one segment,
  `~/.agent-desktop/sessions/<id>/trace/<pid>-<procTs>.jsonl`, and a long-lived host
  reuses it. `ad_trace_show` (JSON envelope) and `ad_trace_export` (self-contained
  HTML file) read the adapter session's merged timeline; `limit` `-1` = CLI default.

- **Log callback.** `ad_set_log_callback(cb)` registers one process-wide callback
  for diagnostics regardless of session manifest. It receives, as JSON, the
  `tracing` events emitted inside later `ad_*` calls on the same thread; the FFI
  never installs or replaces the host process's global tracing subscriber. `cb`
  receives an `int32_t` level (1=ERROR ... 5=TRACE) and a `const char *msg` valid
  only for the duration of the call. Pass `NULL` to unregister. Sensitive field
  values (password, token, text, ...) are replaced with `{"redacted":true}`. The
  callback must not unwind across the C ABI: catch C++ exceptions and Rust panics
  inside it, because a violation may abort the host. It may fire from several host
  threads at once and briefly after a `NULL` unregister: keep the callback and
  any data it captures valid for the process lifetime.

- **Wait.** `ad_wait(adapter, args, &out)` runs the CLI `wait` command. Set
  `mode.pause` (`AdOptionalU64`, ms), `mode.element`, `mode.window` (waits for a
  window with that title), `mode.text`, or one of `mode.surfaces.menu`,
  `.menu_closed`, `.notification`; add the `predicate` group (`predicate`,
  `value`, `action`, `count`) and `scope.timeout_ms` / `scope.app`. The CLI event
  wait (`--event`, `--window-id`) is not exposed. Zero-initialize `AdWaitArgs` and
  validate the struct size against `AD_WAIT_ARGS_SIZE` / `ad_wait_args_size()`
  before calling. The output is a `{version, ok, command, data}` envelope freed with
  `ad_free_string`. `ad_wait` blocks the calling thread up to `scope.timeout_ms` ms. A
  concurrent `ad_adapter_destroy` does not invalidate an in-flight wait.

- **Text input privacy.** On macOS, focus-fallback or headed text insertion may
  briefly use the clipboard for non-ASCII text. For sensitive text, prefer
  `AD_ACTION_KIND_SET_VALUE` with `AD_POLICY_KIND_HEADLESS` when the target
  supports settable values.

- **`ad_get_tree_exact` vs `ad_snapshot`.** `ad_get_tree_exact` returns a raw flat
  breadth-first tree: no refs, no refmap persistence, no JSON envelope (free it
  with `ad_free_tree`). Use it for custom traversal or UI inspection. For
  observe-act agents that drive actions via `ad_execute_by_ref`, start with
  `ad_snapshot`.
