use agent_desktop_core::{AdapterError, ErrorCode};

use crate::tree::AXElement;

#[cfg(target_os = "macos")]
type WindowBridge = unsafe extern "C" fn(accessibility_sys::AXUIElementRef, *mut u32) -> i32;

#[cfg(target_os = "macos")]
pub(crate) fn window_id(
    window: &AXElement,
    deadline: std::time::Instant,
) -> Result<Option<i64>, AdapterError> {
    crate::tree::properties::ax_ipc::prepare(window, deadline)?;
    let bridge = bridge().ok_or_else(bridge_unavailable)?;
    let mut window_id = 0_u32;
    let error = unsafe { bridge(window.0, &mut window_id) };
    classify(error).map(|present| present.then_some(i64::from(window_id)))
}

#[cfg(target_os = "macos")]
pub(crate) fn is_unavailable(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        == Some("resolution_window_bridge_unavailable")
}

#[cfg(target_os = "macos")]
fn bridge() -> Option<WindowBridge> {
    static BRIDGE: std::sync::OnceLock<Option<WindowBridge>> = std::sync::OnceLock::new();
    *BRIDGE.get_or_init(|| {
        let symbol = unsafe { dlsym(RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
        if symbol.is_null() {
            None
        } else {
            Some(unsafe { std::mem::transmute::<*mut std::ffi::c_void, WindowBridge>(symbol) })
        }
    })
}

#[cfg(target_os = "macos")]
const RTLD_DEFAULT: *mut std::ffi::c_void = -2_isize as *mut std::ffi::c_void;

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn dlsym(
        handle: *mut std::ffi::c_void,
        symbol: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_void;
}

/// `kAXErrorIllegalArgument` is the bridge rejecting the element outright, not
/// a busy window that might answer later. Treating it as retryable made callers
/// spin the full resolve budget on a call that can never succeed, and made a
/// window that simply has no CGWindowID look like an unresolved candidate
/// rather than a settled non-match.
#[cfg(target_os = "macos")]
fn classify(error: i32) -> Result<bool, AdapterError> {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorAttributeUnsupported, kAXErrorCannotComplete,
        kAXErrorIllegalArgument, kAXErrorInvalidUIElement, kAXErrorNoValue, kAXErrorSuccess,
    };

    if error == kAXErrorSuccess {
        return Ok(true);
    }
    if error == kAXErrorAttributeUnsupported
        || error == kAXErrorNoValue
        || error == kAXErrorIllegalArgument
    {
        return Ok(false);
    }
    if error == kAXErrorAPIDisabled {
        return Err(
            AdapterError::permission_denied().with_details(serde_json::json!({
                "kind": "resolution_window_bridge",
                "ax_error": error,
                "complete": false,
                "retryable": false,
            })),
        );
    }
    let label = if error == kAXErrorCannotComplete {
        "kAXErrorCannotComplete"
    } else if error == kAXErrorInvalidUIElement {
        "kAXErrorInvalidUIElement"
    } else {
        "unclassified AXError"
    };
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("Could not bridge AXWindow to CGWindow: {label}"),
    )
    .with_suggestion("Retry after the application finishes updating its window inventory")
    .with_details(serde_json::json!({
        "kind": "resolution_window_bridge",
        "ax_error": error,
        "complete": false,
        "retryable": true,
    })))
}

#[cfg(target_os = "macos")]
fn bridge_unavailable() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The optional AX-to-CG window bridge is unavailable on this macOS version",
    )
    .with_suggestion("Target the uniquely titled verified window, or refresh the window inventory")
    .with_details(serde_json::json!({
        "kind": "resolution_window_bridge_unavailable",
        "symbol": "_AXUIElementGetWindow",
        "complete": false,
        "retryable": false,
    }))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn window_id(
    _window: &AXElement,
    _deadline: std::time::Instant,
) -> Result<Option<i64>, AdapterError> {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_unavailable(_error: &AdapterError) -> bool {
    false
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    #[test]
    fn bridge_errors_preserve_permission_and_incomplete_states() {
        assert_eq!(
            classify(kAXErrorAPIDisabled).unwrap_err().code,
            ErrorCode::PermDenied
        );
        for error in [kAXErrorCannotComplete, kAXErrorInvalidUIElement] {
            let classified = classify(error).unwrap_err();
            assert_eq!(classified.code, ErrorCode::AppUnresponsive);
            assert_eq!(classified.details.unwrap()["complete"], false);
        }
    }

    #[test]
    fn illegal_argument_is_a_settled_absence_not_a_retryable_failure() {
        assert!(
            !classify(accessibility_sys::kAXErrorIllegalArgument).unwrap(),
            "a window the bridge rejects outright has no CGWindowID; retrying cannot change that"
        );
    }

    #[test]
    fn unavailable_symbol_is_machine_distinguishable() {
        assert!(is_unavailable(&bridge_unavailable()));
    }
}
