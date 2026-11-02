use crate::AdAdapter;
use crate::error::{self, AdResult};
use crate::ffi_try::trap_panic;
use crate::types::AdDragParams;

/// Synthesizes an explicit physical mouse drag from `params.from` to
/// `params.to`. When `params.duration_ms` is zero the drag is instantaneous;
/// a non-zero value asks the platform adapter to interpolate. Callers that
/// need headless policy enforcement should use ref actions with policy.
///
/// # Safety
/// `adapter` must be a non-null pointer returned by `ad_adapter_create`.
/// `params` must be a non-null pointer to a valid `AdDragParams`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_drag(
    adapter: *const AdAdapter,
    params: *const AdDragParams,
) -> AdResult {
    trap_panic(|| unsafe {
        crate::pointer_guard::guard_non_null!(adapter, c"adapter is null");
        crate::pointer_guard::guard_non_null!(params, c"params is null");
        let p = &*params;
        let core_params = p.to_core();
        let adapter = crate::adapter::acquire_adapter!(adapter);
        let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
        if let Err(error) = core_params.validate(lease.deadline()) {
            error::set_last_error(&error);
            return error::last_error_code();
        }
        match adapter.inner.drag(core_params, &lease) {
            Ok(_) => AdResult::Ok,
            Err(e) => {
                error::set_last_error(&e);
                error::last_error_code()
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AdPoint;

    #[test]
    fn test_drag_zero_duration_and_drop_delay_become_none() {
        let p = AdDragParams {
            from: AdPoint { x: 0.0, y: 0.0 },
            to: AdPoint { x: 100.0, y: 200.0 },
            duration_ms: 0,
            drop_delay_ms: 0,
        };
        let core = p.to_core();
        assert!(core.duration_ms.is_none());
        assert!(core.drop_delay_ms.is_none());
        assert_eq!(core.to.x, 100.0);
    }

    #[test]
    fn test_drag_nonzero_duration_and_drop_delay_pass_through() {
        let p = AdDragParams {
            from: AdPoint { x: 0.0, y: 0.0 },
            to: AdPoint { x: 50.0, y: 50.0 },
            duration_ms: 500,
            drop_delay_ms: 750,
        };
        let core = p.to_core();
        assert_eq!(core.duration_ms, Some(500));
        assert_eq!(core.drop_delay_ms, Some(750));
    }
}
