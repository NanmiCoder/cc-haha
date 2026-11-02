use crate::AdAdapter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::AdExactWindowInfo;
use crate::windows::to_core::ad_exact_window_to_core;

/// Focuses a generation-pinned exact window.
///
/// # Safety
/// `adapter` and `win` must be valid pointers. `win` must carry the current
/// exact-window version and size.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_focus_window_exact(
    adapter: *const AdAdapter,
    win: *const AdExactWindowInfo,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(win, c"win is null");
        let window = match ad_exact_window_to_core(&*win) {
            Ok(window) => window,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        focus_core_window(adapter, &window)
    })
}

fn focus_core_window(
    adapter: *const AdAdapter,
    window: &agent_desktop_core::WindowInfo,
) -> AdResult {
    let adapter = match crate::adapter::lookup_adapter(adapter) {
        Ok(adapter) => adapter,
        Err(error) => {
            set_last_error(&error);
            return crate::error::last_error_code();
        }
    };
    let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
    match adapter.inner.focus_window(window, &lease) {
        Ok(()) => AdResult::Ok,
        Err(error) => {
            set_last_error(&error);
            crate::error::last_error_code()
        }
    }
}
