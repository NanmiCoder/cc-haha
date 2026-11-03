use crate::AdAdapter;
use crate::commands::app_error_to_adapter;
use crate::commands::envelope_out::write_command_envelope;
use crate::convert::string::decode_optional_filter;
use crate::convert::surface::snapshot_surface_from_c;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::pointer_guard::guard_non_null;
use agent_desktop_core::commands::snapshot::SnapshotArgs;
use std::ffi::c_char;
use std::ptr;

/// Takes a full CLI-format snapshot of the target application window,
/// allocates snapshot-qualified refs (`@<snapshot_id>:eN`) for all
/// interactive elements, persists the refmap to disk, and writes the JSON envelope into `*out`.
///
/// The JSON shape matches `agent-desktop snapshot`:
/// `{"version":"2.5","ok":true,"command":"snapshot","data":{"app":"...","window":{...},"ref_count":N,"snapshot_id":"...","complete":true,"tree":{...}}}`.
///
/// `data.complete` is always present. A snapshot that exhausts its observation
/// budget still succeeds with `"complete":false` and the tree it did observe,
/// and then also carries `"truncated":true` and `"nodes_observed":N`; each node
/// whose descendants were cut short carries `"subtree_truncated":true`, a field
/// that is emitted only when true. Callers must read `complete` to decide
/// whether a tree is whole — an incomplete observation is not reported as a
/// `TIMEOUT` error.
///
/// **`*out` ownership and error behaviour:**
/// - On success (`AD_RESULT_OK`): `*out` is a heap-allocated JSON string with `"ok":true`.
///   Caller must free it with `ad_free_string`.
/// - On a command-level error (e.g. app not found, snapshot failure): `*out` is a
///   heap-allocated JSON string with `"ok":false` and an `"error"` payload. Caller
///   must still free it with `ad_free_string`. The last-error slot is also set.
/// - On an argument or infrastructure error (null adapter, invalid
///   UTF-8, bad surface discriminant, context failure): `*out` is set to null and no
///   allocation is made. Only the last-error slot is set.
///
/// `app` is tri-state:
/// - null — snapshot the currently focused window (same as running the command with no `--app`).
/// - valid UTF-8 string — snapshot the named application's focused window.
/// - non-null but invalid UTF-8 or exceeding `AD_MAX_STRING_BYTES` — returns `ErrInvalidArgs`.
///
/// `surface` is an `AdSnapshotSurface` discriminant (0 = Window, 1 = Focused, …).
/// An out-of-range value returns `ErrInvalidArgs`.
///
/// This entrypoint always targets the active focused window of the requested
/// application; explicit window targeting (`window_id`) is not yet exposed
/// over the ABI. Progressive traversal (skeleton mode and `--root` drill-down)
/// is likewise not exposed here. Both are planned fast-follows to this
/// entrypoint — agents needing them should use the CLI in the meantime.
///
/// **Dispatch-before-serialize ordering**: the snapshot and refmap persistence
/// occur before the result JSON is serialised. In the near-impossible event
/// that serialisation of an already-valid result fails, `*out` is set to null
/// and `ErrInternal` is returned while the refmap is already written.
///
/// # Safety
///
/// `adapter` must be a non-null pointer from `ad_adapter_create` or
/// `ad_adapter_create_with_session`. `out` must be a non-null writable
/// `*mut *mut c_char`. `app` must be null or a NUL-terminated string within
/// `AD_MAX_STRING_BYTES + 1` bytes. All pointers must remain valid for the
/// duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_snapshot(
    adapter: *const AdAdapter,
    app: *const c_char,
    surface: i32,
    max_depth: u8,
    interactive_only: bool,
    compact: bool,
    out: *mut *mut c_char,
) -> AdResult {
    guard_non_null!(out, c"out is null");
    unsafe { *out = ptr::null_mut() };
    trap_panic(|| {
        guard_non_null!(adapter, c"adapter is null");

        let app_filter = unsafe { decode_optional_filter!(app, "app") };

        let core_surface = match snapshot_surface_from_c(surface, "surface") {
            Ok(s) => s,
            Err(e) => {
                set_last_error(&e);
                return AdResult::ErrInvalidArgs;
            }
        };
        let adapter_ref = crate::adapter::acquire_adapter!(adapter);
        let context = match adapter_ref.command_context() {
            Ok(ctx) => ctx,
            Err(e) => {
                let ae = app_error_to_adapter(e);
                set_last_error(&ae);
                return crate::error::last_error_code();
            }
        };

        let args = SnapshotArgs {
            app: app_filter,
            window_id: None,
            max_depth,
            include_bounds: false,
            interactive_only,
            compact,
            surface: core_surface,
            skeleton: false,
            root_ref: None,
            timeout_ms: None,
            force_electron_a11y: false,
        };

        let scope = crate::commands::command_scope!(context, "snapshot");

        let result = agent_desktop_core::commands::snapshot::execute(
            args,
            adapter_ref.inner.as_ref(),
            &context,
        );
        crate::commands::complete_scope!(scope, &result);

        unsafe { write_command_envelope("snapshot", result, out) }
    })
}
