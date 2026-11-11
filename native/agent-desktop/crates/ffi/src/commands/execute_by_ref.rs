use crate::AdAdapter;
use crate::error::AdResult;
use crate::types::AdAction;
use std::ffi::c_char;

/// Drives a snapshot-qualified ref action (`@<snapshot_id>:e5`, action)
/// through the canonical ref-action
/// pipeline: `RefStore` load → `RefMap` lookup (→ `STALE_REF` on missing) →
/// strict element resolution (→ `STALE_REF`/`AMBIGUOUS_TARGET`) → live
/// actionability preflight → dispatch → owned-handle drop.
///
/// Policy: semantic actions, including `TypeText`, default to strict
/// `headless`. Explicit `PressKey` defaults to `focus_fallback`. A policy
/// discriminant may elevate to focus fallback or headed. Base and elevation
/// are computed by `agent_desktop_core::commands::execute_by_ref::execute_with_timeout` via
/// `Action::base_interaction_policy` + `InteractionPolicy::join`, so CLI and
/// FFI share a single source of policy truth.
///
/// `ref_id` tri-state: null → `ErrInvalidArgs`; non-null invalid UTF-8 →
/// `ErrInvalidArgs`; valid UTF-8 that is not a snapshot-qualified
/// `@<snapshot_id>:e{N}` ref, including a bare `@e{N}` → `ErrInvalidArgs`.
///
/// `policy` is an `AdPolicyKind` discriminant (0=Headless, 1=FocusFallback,
/// 2=Headed). An out-of-range value returns `ErrInvalidArgs`. `Headless (0)`
/// accepts the action's base policy. `FocusFallback (1)` explicitly permits
/// focus without cursor movement. `Headed (2)` opts in to physical cursor and
/// keyboard delivery.
///
/// Uses a fixed 5000ms auto-wait budget before
/// the actionability preflight, matching the CLI default. Call
/// `ad_execute_by_ref_timeout` with an explicit `timeout_ms` (-1 = default,
/// 0 = single-shot with no auto-wait) to control this.
///
/// On success `*out` is set to a NUL-terminated JSON envelope (command
/// `"execute_by_ref"`); free with `ad_free_string`. On guard or decode
/// failure (invalid args before the command runs) `*out` remains null.
/// On a command-level error (STALE_REF, AMBIGUOUS_TARGET, etc.) `*out`
/// holds the error JSON envelope and must still be freed with
/// `ad_free_string`. The last-error slot is populated on all failures.
///
/// **Dispatch-before-serialize ordering**: the action is dispatched (and any
/// side effects committed) before the result JSON is serialized. In the
/// near-impossible event that serialization of an already-valid
/// `ActionResult` fails, `*out` is null and `ErrInternal` is returned while
/// the side effect has already occurred. No pre-validation machinery is
/// needed because serialization of a valid envelope effectively never fails.
///
/// # Safety
///
/// `adapter` must be a non-null pointer from `ad_adapter_create[_with_session]`.
/// `ref_id` must be a non-null pointer to a NUL-terminated C string within
/// `AD_MAX_STRING_BYTES + 1` bytes; null is **not** optional — it is defined
/// behaviour (no UB) but is rejected immediately with `ErrInvalidArgs`.
/// `action`
/// must be a non-null pointer to a
/// valid `AdAction`. `out` must be a non-null writable pointer. All pointers
/// must remain valid for the duration of the call. Must be called from the
/// calling thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_execute_by_ref(
    adapter: *const AdAdapter,
    ref_id: *const c_char,
    action: *const AdAction,
    policy: i32,
    out: *mut *mut c_char,
) -> AdResult {
    unsafe {
        super::execute_by_ref_timeout::ad_execute_by_ref_timeout(
            adapter, ref_id, action, policy, -1, out,
        )
    }
}
