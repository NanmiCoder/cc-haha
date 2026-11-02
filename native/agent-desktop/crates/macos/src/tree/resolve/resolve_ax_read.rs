use agent_desktop_core::{AdapterError, ErrorCode};

use crate::tree::AXElement;

#[cfg(target_os = "macos")]
pub(crate) fn read_string_with_usage(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
    usage: &mut crate::tree::observation_usage::ObservationUsage,
) -> Result<Option<String>, AdapterError> {
    let value = read_value(element, attribute, deadline, |value| {
        use core_foundation::{
            base::{CFType, TCFType},
            string::CFString,
        };

        let value = unsafe { CFType::wrap_under_create_rule(value) };
        let value = value.downcast::<CFString>()?;
        crate::tree::properties::bounded_string::BoundedString::from_cf(&value, usage).ok()
    })?;
    match value {
        Some(value) if value.complete => Ok(Some(value.value)),
        Some(_) => Err(incomplete_read_error(
            attribute,
            "text budget exhausted",
            i32::MIN,
        )),
        None => Ok(None),
    }
}

pub(crate) fn read_string(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<Option<String>, AdapterError> {
    crate::tree::surface_read::string(element, attribute, deadline)
}

pub(crate) fn read_array(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<Option<Vec<AXElement>>, AdapterError> {
    crate::tree::surface_read::elements(element, attribute, deadline)
        .map(|elements| (!elements.is_empty()).then_some(elements))
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn read_element(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<Option<AXElement>, AdapterError> {
    read_value(element, attribute, deadline, |value| {
        crate::tree::properties::ax_value::created_ax_element(value)
    })
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn read_point(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<Option<core_graphics::geometry::CGPoint>, AdapterError> {
    read_value(element, attribute, deadline, |value| {
        use accessibility_sys::{AXValueGetValue, kAXValueTypeCGPoint};
        use core_graphics::geometry::CGPoint;

        let mut point = CGPoint::new(0.0, 0.0);
        let decoded = unsafe {
            AXValueGetValue(
                value as _,
                kAXValueTypeCGPoint,
                &mut point as *mut _ as *mut std::ffi::c_void,
            )
        };
        unsafe { core_foundation::base::CFRelease(value) };
        decoded.then_some(point)
    })
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn read_size(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
) -> Result<Option<core_graphics::geometry::CGSize>, AdapterError> {
    read_value(element, attribute, deadline, |value| {
        use accessibility_sys::{AXValueGetValue, kAXValueTypeCGSize};
        use core_graphics::geometry::CGSize;

        let mut size = CGSize::new(0.0, 0.0);
        let decoded = unsafe {
            AXValueGetValue(
                value as _,
                kAXValueTypeCGSize,
                &mut size as *mut _ as *mut std::ffi::c_void,
            )
        };
        unsafe { core_foundation::base::CFRelease(value) };
        decoded.then_some(size)
    })
}

#[cfg(target_os = "macos")]
fn read_value<T>(
    element: &AXElement,
    attribute: &str,
    deadline: std::time::Instant,
    decode: impl FnOnce(core_foundation::base::CFTypeRef) -> Option<T>,
) -> Result<Option<T>, AdapterError> {
    use core_foundation::{base::TCFType, string::CFString};

    let attribute_name = CFString::new(attribute);
    let (error, value) = crate::tree::properties::ax_ipc::copy_attribute_value(
        element,
        attribute_name.as_concrete_TypeRef(),
        deadline,
    );
    if std::time::Instant::now() >= deadline {
        release_if_present(value);
        return Err(
            AdapterError::timeout("Strict element resolution deadline exhausted").with_details(
                serde_json::json!({
                    "kind": "resolution_deadline_exhausted",
                    "complete": false,
                }),
            ),
        );
    }
    if !classify_ax_read(error, attribute)? {
        release_if_present(value);
        return Ok(None);
    }
    if value.is_null() {
        return Err(incomplete_read_error(
            attribute,
            "kAXErrorSuccess returned a null value",
            error,
        ));
    }
    decode(value).map(Some).ok_or_else(|| {
        incomplete_read_error(attribute, "unexpected accessibility value type", error)
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn classify_ax_read(error: i32, attribute: &str) -> Result<bool, AdapterError> {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorAttributeUnsupported, kAXErrorCannotComplete,
        kAXErrorInvalidUIElement, kAXErrorNoValue, kAXErrorSuccess,
    };

    if error == kAXErrorSuccess {
        return Ok(true);
    }
    if error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue {
        return Ok(false);
    }
    if error == kAXErrorAPIDisabled {
        return Err(AdapterError::new(
            ErrorCode::PermDenied,
            "Accessibility API is disabled during strict element resolution",
        )
        .with_suggestion("Grant Accessibility permission, then retry")
        .with_details(serde_json::json!({
            "kind": "resolution_ax_read",
            "attribute": attribute,
            "ax_error": error,
            "complete": false,
            "retryable": false,
        })));
    }
    let label = if error == kAXErrorCannotComplete {
        "kAXErrorCannotComplete"
    } else if error == kAXErrorInvalidUIElement {
        "kAXErrorInvalidUIElement"
    } else {
        "unclassified AXError"
    };
    Err(incomplete_read_error(attribute, label, error))
}

#[cfg(target_os = "macos")]
fn incomplete_read_error(attribute: &str, reason: &str, error: i32) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("Strict element resolution could not read {attribute}: {reason}"),
    )
    .with_suggestion("Retry after the target application finishes updating its accessibility tree")
    .with_details(serde_json::json!({
        "kind": "resolution_ax_read",
        "attribute": attribute,
        "ax_error": error,
        "reason": reason,
        "complete": false,
        "retryable": true,
    }))
}

#[cfg(target_os = "macos")]
fn release_if_present(value: core_foundation::base::CFTypeRef) {
    if !value.is_null() {
        unsafe { core_foundation::base::CFRelease(value) };
    }
}
