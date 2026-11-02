/// AppKit's NSAccessibility bridge answers these codes when an element simply
/// does not implement the probed attribute — including `kAXErrorFailure`, which
/// it returns for synthetic `NSAccessibilityElement`s with no support at all.
/// They are complete "none present" answers, not transport failures.
///
/// One definition, because a code that the capability reader calls absent and
/// the attribute reader calls a failure makes the same element readable in one
/// command and broken in another.
pub(crate) fn is_absent_attribute_error(error: i32) -> bool {
    matches!(
        error,
        accessibility_sys::kAXErrorAttributeUnsupported
            | accessibility_sys::kAXErrorNoValue
            | accessibility_sys::kAXErrorNotImplemented
            | accessibility_sys::kAXErrorFailure
    )
}

pub(crate) fn is_absent_action_error(error: i32) -> bool {
    error == accessibility_sys::kAXErrorActionUnsupported || is_absent_attribute_error(error)
}

#[cfg(test)]
mod tests {
    use super::{is_absent_action_error, is_absent_attribute_error};

    #[test]
    fn appkit_failure_code_reads_as_absence_everywhere() {
        assert!(is_absent_attribute_error(
            accessibility_sys::kAXErrorFailure
        ));
        assert!(is_absent_action_error(accessibility_sys::kAXErrorFailure));
    }

    #[test]
    fn transport_failures_are_never_absence() {
        for error in [
            accessibility_sys::kAXErrorCannotComplete,
            accessibility_sys::kAXErrorInvalidUIElement,
            accessibility_sys::kAXErrorAPIDisabled,
        ] {
            assert!(!is_absent_attribute_error(error));
            assert!(!is_absent_action_error(error));
        }
    }
}
