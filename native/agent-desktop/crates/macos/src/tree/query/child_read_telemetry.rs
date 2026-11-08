use accessibility_sys::{
    kAXErrorAPIDisabled, kAXErrorAttributeUnsupported, kAXErrorCannotComplete,
    kAXErrorInvalidUIElement, kAXErrorNoValue, kAXErrorSuccess,
};

use super::child_read_status::ChildReadStatus;

pub(crate) fn record_status(status: &mut ChildReadStatus, error: i32) {
    status.health.cannot_complete += u64::from(error == kAXErrorCannotComplete);
    status.invalid_element |= error == kAXErrorInvalidUIElement;
    status.api_disabled |= error == kAXErrorAPIDisabled;
    status.health.native_read_failures += u64::from(
        error != kAXErrorSuccess
            && error != kAXErrorAttributeUnsupported
            && error != kAXErrorNoValue
            && error != kAXErrorCannotComplete
            && error != kAXErrorInvalidUIElement
            && error != kAXErrorAPIDisabled,
    );
}

pub(crate) fn record(
    status: &mut ChildReadStatus,
    attribute: &str,
    phase: &'static str,
    error: i32,
    child_count: Option<usize>,
) {
    record_status(status, error);
    tracing::debug!(
        attribute,
        phase,
        ax_error_code = error,
        child_count,
        cannot_complete_count = status.health.cannot_complete,
        native_read_failure_count = status.health.native_read_failures,
        invalid_element = status.invalid_element,
        api_disabled = status.api_disabled,
        "AX child read failed"
    );
}
