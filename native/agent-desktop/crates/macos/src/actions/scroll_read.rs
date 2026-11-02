use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use crate::tree::AXElement;

const MAX_SCROLL_CHILDREN: usize = 128;

pub(crate) fn element(
    source: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Option<AXElement>, AdapterError> {
    prepare(source, deadline)?;
    let result =
        crate::tree::properties::attributes::copy_element_attr_result(source, attribute, deadline);
    deadline.ensure_remaining()?;
    result.map_err(|error| read_error(attribute, error))
}

pub(crate) fn children(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Vec<AXElement>, AdapterError> {
    prepare(element, deadline)?;
    let result = crate::tree::properties::attributes::copy_ax_array_prefix_result(
        element,
        "AXChildren",
        MAX_SCROLL_CHILDREN,
        deadline,
    );
    deadline.ensure_remaining()?;
    let children = result
        .map(|children| children.unwrap_or_default())
        .map_err(|error| read_error("AXChildren", error))?;
    if children.len() == MAX_SCROLL_CHILDREN {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Scroll sub-element lookup reached its bounded child limit",
        )
        .with_details(serde_json::json!({ "complete": false })));
    }
    Ok(children)
}

pub(crate) fn string(
    element: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    prepare(element, deadline)?;
    let result =
        crate::tree::properties::attributes::copy_string_attr_result(element, attribute, deadline);
    deadline.ensure_remaining()?;
    result.map_err(|error| read_error(attribute, error))
}

pub(crate) fn number(
    element: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Option<f64>, AdapterError> {
    use accessibility_sys::kAXErrorSuccess;
    use core_foundation::{base::TCFType, number::CFNumber, string::CFString};

    prepare(element, deadline)?;
    let attribute = CFString::new(attribute);
    let (error, value) = crate::tree::properties::ax_ipc::copy_attribute_value(
        element,
        attribute.as_concrete_TypeRef(),
        deadline,
    );
    deadline.ensure_remaining()?;
    if error != kAXErrorSuccess {
        return if error == accessibility_sys::kAXErrorNoValue
            || error == accessibility_sys::kAXErrorAttributeUnsupported
        {
            Ok(None)
        } else {
            Err(read_error("AXValue", error))
        };
    }
    if value.is_null() {
        return Ok(None);
    }
    let value = unsafe { core_foundation::base::CFType::wrap_under_create_rule(value) };
    Ok(value
        .downcast::<CFNumber>()
        .and_then(|number| number.to_f64()))
}

fn prepare(element: &AXElement, deadline: Deadline) -> Result<(), AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)
}

fn read_error(attribute: &str, error: i32) -> AdapterError {
    AdapterError::new(
        if error == accessibility_sys::kAXErrorCannotComplete {
            ErrorCode::Timeout
        } else if error == accessibility_sys::kAXErrorAPIDisabled {
            ErrorCode::PermDenied
        } else if error == accessibility_sys::kAXErrorInvalidUIElement {
            ErrorCode::StaleRef
        } else {
            ErrorCode::ActionFailed
        },
        format!("Accessibility read failed for {attribute} during scroll"),
    )
    .with_details(serde_json::json!({ "attribute": attribute, "ax_error": error }))
}
