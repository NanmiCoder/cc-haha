use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, WindowInfo};

#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
const VERIFY_LIMIT: Duration = Duration::from_millis(500);

#[cfg(target_os = "macos")]
pub(crate) fn ensure_app_focused(pid: i32, deadline: Deadline) -> Result<(), AdapterError> {
    focus_app(pid, deadline).map(|_| ())
}

#[cfg(target_os = "macos")]
fn focus_app(pid: i32, deadline: Deadline) -> Result<bool, AdapterError> {
    use core_foundation::{base::TCFType, boolean::CFBoolean, string::CFString};

    tracing::debug!("system: ensure app focused pid={pid}");
    let app = crate::tree::element_for_pid(pid);
    if read_frontmost(&app, deadline)? {
        return Ok(false);
    }
    prepare(&app, deadline)?;
    let attribute = CFString::new("AXFrontmost");
    let error = crate::tree::properties::ax_ipc::set_attribute_value(
        &app,
        attribute.as_concrete_TypeRef(),
        CFBoolean::true_value().as_CFTypeRef(),
        deadline,
    )?;
    finish_mutation(&app, error, "focus application", deadline)?;
    wait_until(
        &app,
        "AXFrontmost",
        deadline,
        "application did not become frontmost",
    )
    .map(|()| true)
    .map_err(after_delivery)
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_app_focused(pid: i32, deadline: Deadline) -> Result<(), AdapterError> {
    let app = crate::tree::element_for_pid(pid);
    if read_frontmost(&app, deadline)? {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Target application lost focus before physical input delivery",
        )
        .with_details(serde_json::json!({
            "pid": pid,
            "physical_delivery_started": false,
        }))
        .with_suggestion("Retry after ensuring the target application remains frontmost"))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn focus_window_impl(
    window: &WindowInfo,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    tracing::debug!("system: focus window");
    let pid = crate::system::process::process_identity::to_pid_t(window.pid)?;
    let element = crate::system::window::window_resolve::window_element_for_info(window, deadline)?;
    let focused = focus_app(pid, deadline)?;
    crate::system::window::window_ops::raise_window(&element, deadline).map_err(|error| {
        crate::actions::DeliveryTracker::from_delivered_units(usize::from(focused)).annotate(error)
    })?;
    verify_app_focused(pid, deadline).map_err(after_delivery)
}

#[cfg(target_os = "macos")]
pub(crate) fn wait_until_main(
    window: &crate::tree::AXElement,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    wait_until(window, "AXMain", deadline, "window did not become main")
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_window_main(
    window: &crate::tree::AXElement,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if read_boolean(window, "AXMain", deadline)? {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Target window lost main-window status before physical input delivery",
        )
        .with_details(serde_json::json!({ "physical_delivery_started": false }))
        .with_suggestion("Retry after bringing the target window to the front"))
    }
}

#[cfg(target_os = "macos")]
fn read_frontmost(app: &crate::tree::AXElement, deadline: Deadline) -> Result<bool, AdapterError> {
    read_boolean(app, "AXFrontmost", deadline)
}

#[cfg(target_os = "macos")]
fn read_boolean(
    element: &crate::tree::AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    prepare(element, deadline)?;
    let result =
        crate::tree::properties::attributes::copy_bool_attr_result(element, attribute, deadline);
    deadline.ensure_remaining()?;
    match result {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Ok(false),
        Err(error) => Err(map_ax_read_error(error, "verify focus")),
    }
}

#[cfg(target_os = "macos")]
fn wait_until(
    element: &crate::tree::AXElement,
    attribute: &str,
    deadline: Deadline,
    timeout_message: &str,
) -> Result<(), AdapterError> {
    let local_deadline = Instant::now() + VERIFY_LIMIT;
    loop {
        if read_boolean(element, attribute, deadline)? {
            return Ok(());
        }
        deadline.ensure_remaining()?;
        if Instant::now() >= local_deadline {
            return Err(
                AdapterError::timeout(timeout_message).with_details(serde_json::json!({
                    "kind": "focus_verification",
                    "physical_delivery_started": false,
                })),
            );
        }
        let pause = deadline.remaining_slice(Duration::from_millis(5))?;
        std::thread::sleep(pause.min(Duration::from_millis(5)));
    }
}

#[cfg(target_os = "macos")]
fn prepare(element: &crate::tree::AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

#[cfg(target_os = "macos")]
pub(crate) fn finish_mutation(
    element: &crate::tree::AXElement,
    error: i32,
    operation: &str,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let delivered = crate::actions::ax_mutation::classify_result(
        element,
        operation,
        "AXUIElement mutation",
        error,
    )?;
    if !delivered {
        return Err(AdapterError::new(
            ErrorCode::ActionNotSupported,
            format!("Accessibility does not support {operation}"),
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if deadline.is_expired() {
        return Err(deadline
            .timeout_error()
            .with_details(serde_json::json!({
                "kind": "mutation_completed_after_deadline",
                "operation": operation,
            }))
            .with_disposition(DeliverySemantics::delivered_unverified()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn map_ax_read_error(error: i32, operation: &str) -> AdapterError {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    let code = if error == kAXErrorAPIDisabled {
        ErrorCode::PermDenied
    } else if error == kAXErrorCannotComplete {
        ErrorCode::Timeout
    } else if error == kAXErrorInvalidUIElement {
        ErrorCode::StaleRef
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(code, format!("Could not {operation} through accessibility"))
        .with_details(serde_json::json!({ "ax_error": error }))
        .with_suggestion("Refresh the target and retry")
        .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(target_os = "macos")]
fn after_delivery(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_app_focused(_pid: i32, _deadline: Deadline) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("focus_app"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn focus_window_impl(
    _window: &WindowInfo,
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("focus_window"))
}
