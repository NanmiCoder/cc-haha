use agent_desktop_core::{AdapterError, ErrorCode};
use std::time::Instant;

pub(crate) fn elements(
    element: &super::AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Vec<super::AXElement>, AdapterError> {
    elements_with_reader(attribute, deadline, |attribute| {
        super::query::child_read::read_attribute_children(
            element,
            attribute,
            agent_desktop_core::ObservationBudget::default().max_children_per_node,
            deadline,
        )
    })
}

fn elements_with_reader(
    attribute: &str,
    deadline: Instant,
    read_attribute: impl FnMut(&str) -> super::query::child_read::ChildRead,
) -> Result<Vec<super::AXElement>, AdapterError> {
    let read = super::query::child_source::read_resilient(&[attribute], deadline, read_attribute);
    ensure_before_deadline(deadline)?;
    if read.status.api_disabled {
        return Err(map_error(attribute, accessibility_sys::kAXErrorAPIDisabled));
    }
    if read.status.invalid_element {
        return Err(map_error(
            attribute,
            accessibility_sys::kAXErrorInvalidUIElement,
        ));
    }
    if !read.complete || read.truncated() {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            format!("Accessibility surface read was incomplete for {attribute}"),
        )
        .with_details(serde_json::json!({
            "kind": "surface_array_incomplete",
            "attribute": attribute,
            "complete": false,
            "total_count": read.total_count,
            "loaded_count": read.elements.len(),
            "count_changed": read.status.count_changed,
            "ax_error": native_ax_error(
                read.status.api_disabled,
                read.status.invalid_element,
                read.status.health.cannot_complete,
            ),
            "read_health": read.status.health,
        })));
    }
    Ok(read.elements)
}

fn native_ax_error(api_disabled: bool, invalid_element: bool, cannot_complete: u64) -> Option<i32> {
    if api_disabled {
        Some(accessibility_sys::kAXErrorAPIDisabled)
    } else if invalid_element {
        Some(accessibility_sys::kAXErrorInvalidUIElement)
    } else if cannot_complete > 0 {
        Some(accessibility_sys::kAXErrorCannotComplete)
    } else {
        None
    }
}

pub(crate) fn element(
    source: &super::AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<super::AXElement>, AdapterError> {
    prepare(source, deadline)?;
    finish(
        super::properties::attributes::copy_element_attr_result(source, attribute, deadline),
        attribute,
        deadline,
    )
}

pub(crate) fn string(
    element: &super::AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<String>, AdapterError> {
    prepare(element, deadline)?;
    finish(
        super::properties::attributes::copy_string_attr_result(element, attribute, deadline),
        attribute,
        deadline,
    )
}

pub(crate) fn boolean(
    element: &super::AXElement,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<bool>, AdapterError> {
    prepare(element, deadline)?;
    finish(
        super::properties::attributes::copy_bool_attr_result(element, attribute, deadline),
        attribute,
        deadline,
    )
}

pub(crate) fn ensure_before_deadline(deadline: Instant) -> Result<(), AdapterError> {
    if Instant::now() >= deadline {
        return Err(deadline_error());
    }
    Ok(())
}

fn prepare(element: &super::AXElement, deadline: Instant) -> Result<(), AdapterError> {
    if deadline.saturating_duration_since(Instant::now()).is_zero() {
        return Err(deadline_error());
    }
    super::properties::attributes::set_messaging_timeout(element, deadline)?;
    Ok(())
}

fn finish<T>(
    result: Result<Option<T>, i32>,
    attribute: &str,
    deadline: Instant,
) -> Result<Option<T>, AdapterError> {
    ensure_before_deadline(deadline)?;
    result.map_err(|error| map_error(attribute, error))
}

fn map_error(attribute: &str, error: i32) -> AdapterError {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    let code = if error == kAXErrorAPIDisabled {
        ErrorCode::PermDenied
    } else if error == kAXErrorCannotComplete {
        ErrorCode::Timeout
    } else if error == kAXErrorInvalidUIElement {
        ErrorCode::ElementNotFound
    } else {
        ErrorCode::ActionFailed
    };
    AdapterError::new(
        code,
        format!("Accessibility surface read failed for {attribute}"),
    )
    .with_details(serde_json::json!({
        "attribute": attribute,
        "ax_error": error,
        "kind": "surface_read",
    }))
    .with_suggestion("Retry after the application finishes updating its accessibility surfaces")
}

fn deadline_error() -> AdapterError {
    AdapterError::timeout("Accessibility surface resolution exceeded its absolute deadline")
}

#[cfg(test)]
mod tests {
    use super::*;
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorInvalidUIElement,
    };

    #[test]
    fn classifier_preserves_permission_timeout_and_stale_states() {
        assert_eq!(
            map_error("AXRole", kAXErrorAPIDisabled).code,
            ErrorCode::PermDenied
        );
        assert_eq!(
            map_error("AXRole", kAXErrorCannotComplete).code,
            ErrorCode::Timeout
        );
        assert_eq!(
            map_error("AXRole", kAXErrorInvalidUIElement).code,
            ErrorCode::ElementNotFound
        );
    }

    #[test]
    fn expired_deadline_fails_without_native_reads() {
        let error = ensure_before_deadline(Instant::now()).expect_err("expired deadline");

        assert_eq!(error.code, ErrorCode::Timeout);
    }

    #[test]
    fn native_ax_error_prioritizes_permission_over_other_signals() {
        assert_eq!(native_ax_error(true, true, 5), Some(kAXErrorAPIDisabled));
    }

    #[test]
    fn native_ax_error_reports_cannot_complete_when_reads_were_merely_busy() {
        assert_eq!(
            native_ax_error(false, false, 1),
            Some(kAXErrorCannotComplete)
        );
    }

    #[test]
    fn native_ax_error_is_absent_without_any_native_failure() {
        assert_eq!(native_ax_error(false, false, 0), None);
    }

    #[test]
    fn surface_read_recovers_transient_failure_before_reporting_missing_windows() {
        let mut calls = 0;
        let result = elements_with_reader(
            "AXWindows",
            Instant::now() + std::time::Duration::from_secs(60),
            |attribute| {
                assert_eq!(attribute, "AXWindows");
                calls += 1;
                let mut read = super::super::query::child_read::ChildRead::empty(calls > 1);
                read.status.health.cannot_complete = u64::from(calls == 1);
                read
            },
        );
        assert_eq!(calls, 2);
        assert!(result.unwrap().is_empty());
    }
}
