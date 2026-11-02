use crate::types::{AdWaitMode, AdWaitPredicate, AdWaitScope};

/// Arguments for `ad_wait`, mirroring `core::commands::wait::WaitArgs` for
/// the pause/element/text/surface wait modes and predicates.
///
/// The core event-wait mode (`--event` / `--window-id`) is intentionally not
/// exposed over FFI in this release; `wait_args_from_ffi` always forwards
/// `event: None` and `window_id: None` to core. `mode.window` here is a
/// title-appearance wait (poll until a window with the given title exists),
/// which is a distinct semantic from the deferred event-wait mode.
///
/// Mode, predicate, and scope fields are grouped into named PODs. Optional
/// numbers use `AdOptional*`; optional strings are nullable pointers.
///
/// Callers must zero-initialize before use and verify layout via
/// `AD_WAIT_ARGS_SIZE` / `ad_wait_args_size()`.
#[repr(C)]
pub struct AdWaitArgs {
    pub mode: AdWaitMode,
    pub predicate: AdWaitPredicate,
    pub scope: AdWaitScope,
}

/// Pinned size of `AdWaitArgs` on 64-bit targets. The compile-time
/// assert below and the `ad_wait_args_size()` runtime getter form the
/// 3-layer pin: Rust const assert, C `_Static_assert` in the header,
/// and the test in `c_abi_layout.rs`.
pub const AD_WAIT_ARGS_SIZE: usize = 104;

const _: () = assert!(std::mem::size_of::<AdWaitArgs>() == AD_WAIT_ARGS_SIZE);

/// Returns the size of `AdWaitArgs` as compiled. Ctypes and other
/// foreign bindings must call this and compare against their own
/// `sizeof` before passing args to `ad_wait`.
#[unsafe(no_mangle)]
pub extern "C" fn ad_wait_args_size() -> usize {
    std::mem::size_of::<AdWaitArgs>()
}
