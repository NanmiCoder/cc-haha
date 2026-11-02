use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Rect};

use crate::tree::AXElement;

const MAX_NOTIFICATION_CHILDREN: usize = 256;

#[cfg(test)]
#[path = "read_tests.rs"]
mod tests;

pub(super) fn children(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Vec<AXElement>, AdapterError> {
    children_for_attribute(element, "AXChildren", deadline)
}

pub(super) fn children_for_attribute(
    element: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Vec<AXElement>, AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)?;
    let result = crate::tree::properties::attributes::copy_ax_array_prefix_result(
        element,
        attribute,
        MAX_NOTIFICATION_CHILDREN,
        deadline,
    );
    deadline.ensure_remaining()?;
    let children = result
        .map(|value| value.unwrap_or_default())
        .map_err(|error| read_error(attribute, error))?;
    if children.len() == MAX_NOTIFICATION_CHILDREN {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Notification traversal reached its bounded child limit",
        )
        .with_details(serde_json::json!({ "complete": false })));
    }
    Ok(children)
}

pub(super) fn string(
    element: &AXElement,
    attribute: &str,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)?;
    let result =
        crate::tree::properties::attributes::copy_string_attr_result(element, attribute, deadline);
    deadline.ensure_remaining()?;
    result.map_err(|error| read_error(attribute, error))
}

pub(super) fn title_or_description(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    title_or_description_with(|attribute| string(element, attribute, deadline))
}

fn title_or_description_with(
    mut read: impl FnMut(&str) -> Result<Option<String>, AdapterError>,
) -> Result<Option<String>, AdapterError> {
    match read("AXTitle")? {
        Some(title) => Ok(Some(title)),
        None => read("AXDescription"),
    }
}

pub(super) fn tolerate_ax_strategy_error(
    error: AdapterError,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    match error.code {
        ErrorCode::ActionFailed
        | ErrorCode::ActionNotSupported
        | ErrorCode::StaleRef
        | ErrorCode::AppUnresponsive => Ok(()),
        _ => Err(error),
    }
}

pub(super) fn bounds(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    let read_deadline = crate::tree::locator_deadline::from_operation(deadline)?;
    crate::tree::element_bounds::read_bounds_with_deadline(element, read_deadline)
}

fn read_error(attribute: &str, error: i32) -> AdapterError {
    let code = if error == accessibility_sys::kAXErrorCannotComplete {
        ErrorCode::AppUnresponsive
    } else if error == accessibility_sys::kAXErrorAPIDisabled {
        ErrorCode::PermDenied
    } else if error == accessibility_sys::kAXErrorInvalidUIElement {
        ErrorCode::StaleRef
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(code, format!("Accessibility read failed for {attribute}"))
        .with_details(serde_json::json!({
            "attribute": attribute,
            "ax_error": error,
            "retryable": error == accessibility_sys::kAXErrorCannotComplete,
        }))
        .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}
