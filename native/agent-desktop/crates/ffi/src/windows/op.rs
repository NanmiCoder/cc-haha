use crate::AdAdapter;
use crate::error::{AdResult, set_last_error};
use crate::ffi_try::trap_panic;
use crate::types::{AdExactWindowInfo, AdWindowOp, AdWindowOpKind};
use crate::windows::to_core::ad_exact_window_to_core;
use agent_desktop_core::WindowOp;

/// Performs a window-manager operation against an exact generation-pinned
/// window identity.
///
/// # Safety
/// `adapter` and `win` must be valid pointers. `win` must carry the current
/// exact-window version and size.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ad_window_op_exact(
    adapter: *const AdAdapter,
    win: *const AdExactWindowInfo,
    op: AdWindowOp,
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
        let op = match decode_window_op(op) {
            Ok(op) => op,
            Err(error) => {
                set_last_error(&error);
                return crate::error::last_error_code();
            }
        };
        perform_window_op(adapter, &window, op)
    })
}

fn decode_window_op(op: AdWindowOp) -> Result<WindowOp, agent_desktop_core::AdapterError> {
    let kind = AdWindowOpKind::from_c(op.kind).ok_or_else(|| {
        agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "invalid window op kind discriminant",
        )
    })?;
    let invalid_geometry = match kind {
        AdWindowOpKind::Resize => {
            !op.width.is_finite()
                || !op.height.is_finite()
                || op.width <= 0.0
                || op.height <= 0.0
                || op.width > 10_000_000.0
                || op.height > 10_000_000.0
        }
        AdWindowOpKind::Move => {
            !op.x.is_finite()
                || !op.y.is_finite()
                || op.x.abs() > 10_000_000.0
                || op.y.abs() > 10_000_000.0
        }
        _ => false,
    };
    if invalid_geometry {
        return Err(agent_desktop_core::AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "window geometry must be finite, bounded, and positive for resize",
        ));
    }
    Ok(match kind {
        AdWindowOpKind::Resize => WindowOp::Resize {
            width: op.width,
            height: op.height,
        },
        AdWindowOpKind::Move => WindowOp::Move { x: op.x, y: op.y },
        AdWindowOpKind::Minimize => WindowOp::Minimize,
        AdWindowOpKind::Maximize => WindowOp::Maximize,
        AdWindowOpKind::Restore => WindowOp::Restore,
    })
}

fn perform_window_op(
    adapter: *const AdAdapter,
    window: &agent_desktop_core::WindowInfo,
    op: WindowOp,
) -> AdResult {
    let adapter = match crate::adapter::lookup_adapter(adapter) {
        Ok(adapter) => adapter,
        Err(error) => {
            set_last_error(&error);
            return crate::error::last_error_code();
        }
    };
    let lease = crate::operation::interaction_lease!(adapter.inner.as_ref());
    match adapter.inner.window_op(window, op, &lease) {
        Ok(_) => AdResult::Ok,
        Err(error) => {
            set_last_error(&error);
            crate::error::last_error_code()
        }
    }
}
