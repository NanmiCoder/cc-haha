# Pointer ownership

Every pointer the FFI hands you to own has a matching free function. Always
call it: Rust allocated the memory, so C's `free()` cannot release it.
Borrowed pointers, such as the `ad_last_error_*` strings, are never freed;
they follow the lifetime contract in error-handling.md.

## Allocation / release table

### Command-backed JSON strings

These entrypoints write an owned, NUL-terminated JSON envelope into `*out`.
Free it with `ad_free_string`. On an infrastructure error `*out` stays null
(see "dual-failure modes" in error-handling.md).

| Allocates                                                                         | Frees with              |
|-----------------------------------------------------------------------------------|-------------------------|
| `ad_version(&out)`                                                                | `ad_free_string(out)`   |
| `ad_status(adapter, &out)`                                                        | `ad_free_string(out)`   |
| `ad_snapshot(adapter, app, surface, max_depth, interactive_only, compact, &out)` | `ad_free_string(out)`   |
| `ad_execute_by_ref(adapter, ref_id, action, policy, &out)`                       | `ad_free_string(out)`   |
| `ad_execute_by_ref_timeout(adapter, ref_id, action, policy, timeout_ms, &out)`   | `ad_free_string(out)`   |
| `ad_wait(adapter, args, &out)`                                                    | `ad_free_string(out)`   |
| `ad_trace_show(adapter, limit, event_prefix, &out)`                               | `ad_free_string(out)`   |
| `ad_trace_export(adapter, limit, out_path, &out)`                                 | `ad_free_string(out)`   |

### Adapter lifecycle

| Allocates                                            | Frees with                              |
|------------------------------------------------------|-----------------------------------------|
| `ad_adapter_create()`                                | `ad_adapter_destroy(adapter)`           |
| `ad_adapter_create_with_session(session)`            | `ad_adapter_destroy(adapter)`           |

### Opaque list handles

| Allocates                                                    | Frees with                              |
|--------------------------------------------------------------|-----------------------------------------|
| `ad_list_apps(adapter, &list)`                               | `ad_app_list_free(list)`                |
| `ad_list_displays(adapter, &list)`                           | `ad_display_list_free(list)`            |
| `ad_list_windows_exact(adapter, app, focused, &list)`        | `ad_exact_window_list_free(list)`       |
| `ad_list_surfaces_exact(adapter, pid, &list)`                | `ad_exact_surface_list_free(list)`      |
| `ad_list_notifications(adapter, filter, &list)`              | `ad_notification_list_free(list)`       |
| `ad_dismiss_all_notifications(adapter, f, &ok, &fail)`       | `ad_notification_list_free` on each, or `ad_dismiss_all_notifications_free(ok, fail)` |

### App / window lifecycle

| Allocates                                                 | Frees with                                                          |
|-----------------------------------------------------------|---------------------------------------------------------------------|
| `ad_launch_app_exact(adapter, id, timeout, &out)`         | `ad_release_exact_window_fields(&out)` |

### Raw tree and element access

| Allocates                                                                              | Frees with                              |
|----------------------------------------------------------------------------------------|-----------------------------------------|
| `ad_get_tree_exact(adapter, win, opts, &out)`                                          | `ad_free_tree(&out)`                    |
| `ad_resolve_element_exact(adapter, entry, &handle)`                                    | `ad_free_handle(adapter, &handle)`: zeroes `handle.ptr` so a follow-up call is a no-op |
| `ad_find_exact(adapter, win, query, &handle)`                                          | same as `ad_resolve_element_exact`      |

### Action results

| Allocates                                                                              | Frees with                   |
|----------------------------------------------------------------------------------------|------------------------------|
| `ad_execute_action(adapter, handle, action, &out)`                                     | `ad_free_action_result(&out)` |
| `ad_execute_action_with_policy(adapter, handle, action, policy, &out)`                 | `ad_free_action_result(&out)` |
| `ad_execute_ref_action_exact_with_policy(adapter, entry, action, policy, &out)`        | `ad_free_action_result(&out)` |
| `ad_notification_action(adapter, &request, &out)`: set `request.identity` from `ad_list_notifications` and choose an explicit non-headless policy; reorder mismatches fail closed | `ad_free_action_result(&out)` |

### Clipboard and image buffers

| Allocates                                   | Frees with                                                          |
|---------------------------------------------|---------------------------------------------------------------------|
| `ad_get_clipboard(adapter, &text)`          | `ad_free_string(text)`                                              |
| `ad_get(adapter, handle, property, &text)`  | `ad_free_string(text)`: text may be null when the property is absent; `ad_free_string(NULL)` is a no-op |
| `ad_screenshot(adapter, target, &buf)`      | `ad_image_buffer_free(buf)` (buf is opaque; read via `ad_image_buffer_{data,size,width,height,format}`) |

## Rules

- Every free function is **null-tolerant**. `ad_free_tree(NULL)`,
  `ad_free_handle(adapter, NULL)`, `ad_free_string(NULL)`, etc. are
  no-ops. List accessors (`ad_*_list_count`, `_get`) also accept null
  and return `0` / `NULL` respectively. `ad_free_handle` checks the adapter
  first, so a null adapter returns `AD_RESULT_ERR_INVALID_ARGS` even with a
  null handle.
- **Double-free of list handles and `AdImageBuffer` is undefined.** The
  opaque wrappers are allocated by `Box::into_raw`; the second call
  would invoke `Box::from_raw` on a freed allocation. Always set the
  pointer to `NULL` after freeing.
- **`ad_free_handle` is safe to double-call**: it zeroes `handle.ptr`
  after the platform release, so a follow-up call sees `NULL` and
  returns `AD_RESULT_OK` without re-entering `CFRelease`.
- **Free handles before destroying their adapter.** `ad_execute_action*` needs
  the live adapter that produced the handle, on the same thread.
  `ad_adapter_destroy` does not release outstanding handles. `ad_free_handle`
  compares only the adapter pointer value, so it still succeeds after
  destroy when given that same pointer; the handle stays allocated until
  then. A wrong-adapter, cross-thread, forged, or unzeroed already-freed
  copy returns `AD_RESULT_ERR_INVALID_ARGS`, leaves the struct unchanged, and
  never dereferences foreign memory.
- Pointers inside a struct (`.id`, `.title`, `.app_name`, each
  `AdNotificationInfo.body`, etc.) are freed by the struct's owning
  free function (list_free / release_fields); do not call
  `ad_free_string()` on them individually.
- `AdActionResult` owns `action`, `ref_id`, `post_state`,
  `post_state.states`, `steps`, and each `steps[i].label` /
  `steps[i].outcome`; free all of them only through
  `ad_free_action_result(&out)`. Treat the returned counts as
  read-only metadata; release the unmodified result struct.
- Ownership does **not** transfer back to Rust after you free. Keep a
  local `NULL` to prevent accidental reuse.

## Out-param zeroing

Every fallible FFI function zeroes its out-param **before** any guard
(pointer validation, UTF-8 validation, enum validation). On error,
calling the paired free function is safe: all pointers inside are
guaranteed null, all counts zero, so the free is a no-op rather than
a double-free on a previous caller's allocation.

In particular:

- `ad_get_clipboard` writes `*out = NULL` before the adapter call:
  no stale buffer visible on error.
- `ad_launch_app_exact` writes `*out = zeroed AdExactWindowInfo` before the
  platform call; `ad_release_exact_window_fields(&out)` on the zero-init
  struct is a no-op.
- `ad_screenshot` writes `*out = NULL` before allocating the image
  buffer: no stale pointer when the screenshot fails.
- `ad_snapshot`, `ad_execute_by_ref`, `ad_execute_by_ref_timeout`, `ad_wait`,
  `ad_status`, `ad_version`, `ad_trace_show`, `ad_trace_export` write
  `*out = NULL` before any guard, so on
  infrastructure failures no allocation is made and `ad_free_string(NULL)`
  is a safe no-op.
- `ad_*_list` and `ad_resolve_element_exact` / `ad_find_exact` all apply the same
  pattern to their handle / list out-params.
