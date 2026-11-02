use accessibility_sys::{
    kAXErrorAPIDisabled, kAXErrorActionUnsupported, kAXErrorAttributeUnsupported,
    kAXErrorCannotComplete, kAXErrorFailure, kAXErrorIllegalArgument, kAXErrorInvalidUIElement,
    kAXErrorNoValue, kAXErrorNotImplemented, kAXErrorSuccess,
};
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

pub(crate) const PERFORM_API: &str = "AXUIElementPerformAction";

pub(crate) fn classify_result(
    _element: &crate::tree::AXElement,
    operation: &str,
    api: &str,
    error: i32,
) -> Result<bool, AdapterError> {
    classify(operation, api, error)
}

fn classify(operation: &str, api: &str, error: i32) -> Result<bool, AdapterError> {
    let signal = signal_or_error(operation, api, error)?;
    if signal == PerformSignal::Uninformative && api == PERFORM_API {
        return settle_uninformative_perform(operation, error, false)
            .map(|outcome| outcome.was_delivered());
    }
    Ok(signal == PerformSignal::ReportedDelivered)
}

fn signal_or_error(operation: &str, api: &str, error: i32) -> Result<PerformSignal, AdapterError> {
    if error == kAXErrorSuccess {
        return Ok(PerformSignal::ReportedDelivered);
    }
    if error == kAXErrorActionUnsupported || error == kAXErrorNotImplemented {
        return Ok(PerformSignal::ReportedUnsupported);
    }
    if error == kAXErrorFailure {
        return Err(crate::actions::DeliveryTracker::uncertain(
            AdapterError::new(
                ErrorCode::ActionFailed,
                format!("{operation} returned kAXErrorFailure; mutation outcome is uncertain"),
            )
            .with_details(serde_json::json!({
                "ax_error": error,
                "operation": operation,
            }))
            .with_platform_detail(format!("{api}({operation}) returned {error}"))
            .with_suggestion(
                "Inspect the target state with a fresh snapshot before deciding whether to retry.",
            ),
        ));
    }
    if error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue {
        return Ok(PerformSignal::Uninformative);
    }
    if error == kAXErrorAPIDisabled {
        return Err(AdapterError::permission_denied()
            .with_platform_detail(format!(
                "{api}({operation}) failed with kAXErrorAPIDisabled"
            ))
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    if error == kAXErrorInvalidUIElement {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            format!("{operation} targeted an invalid accessibility element"),
        )
        .with_details(serde_json::json!({
            "ax_error": "kAXErrorInvalidUIElement",
            "operation": operation,
        }))
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion("Refresh the snapshot and retry with the new element reference."));
    }
    if error == kAXErrorIllegalArgument {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("{operation} rejected an invalid accessibility argument"),
        )
        .with_platform_detail(format!("{api}({operation}) returned {error}"))
        .with_details(serde_json::json!({
            "ax_error": error,
            "operation": operation,
        }))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let (code, label) = if error == kAXErrorCannotComplete {
        (ErrorCode::AppUnresponsive, "kAXErrorCannotComplete")
    } else {
        (ErrorCode::ActionFailed, "unclassified AXError")
    };
    Err(crate::actions::DeliveryTracker::uncertain(
        AdapterError::new(
            code,
            format!("{operation} returned {label}; mutation outcome is uncertain"),
        )
        .with_details(serde_json::json!({
            "ax_error": error,
            "operation": operation,
        }))
        .with_platform_detail(format!("{api}({operation}) returned {error}"))
        .with_suggestion(
            "Inspect the target state with a fresh snapshot before deciding whether to retry.",
        ),
    ))
}

/// How much a perform return code proves. Responders break the contract in both
/// directions — a code that reports failure after acting, and success after
/// doing nothing — so delivery is settled by observation, not by the code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PerformSignal {
    ReportedDelivered,
    ReportedUnsupported,
    Uninformative,
}

pub(crate) fn classify_perform(operation: &str, error: i32) -> Result<PerformSignal, AdapterError> {
    signal_or_error(operation, PERFORM_API, error)
}

pub(crate) fn settle_uninformative_perform(
    operation: &str,
    error: i32,
    observed_effect: bool,
) -> Result<crate::actions::chain::chain_delivery::DeliveryOutcome, AdapterError> {
    if observed_effect {
        return Ok(crate::actions::chain::chain_delivery::DeliveryOutcome::DeliveredVerified);
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        format!("{operation} did not establish a verifiable effect; mutation outcome is uncertain"),
    )
    .with_disposition(DeliverySemantics::uncertain())
    .with_details(serde_json::json!({ "ax_error": error, "operation": operation }))
    .with_suggestion(
        "Inspect the target state with a fresh snapshot before deciding whether to retry.",
    ))
}

#[cfg(test)]
mod tests {
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorActionUnsupported, kAXErrorAttributeUnsupported,
        kAXErrorCannotComplete, kAXErrorFailure, kAXErrorInvalidUIElement, kAXErrorSuccess,
    };
    use agent_desktop_core::{DeliveryDisposition, ErrorCode, RetryDisposition};

    use super::classify;

    #[test]
    fn success_is_delivered() {
        let result = classify("AXPress", "perform", kAXErrorSuccess);
        assert!(result.unwrap());
    }

    #[test]
    fn uninformative_perform_without_observed_effect_stops_fallback() {
        let error =
            super::settle_uninformative_perform("AXOpen", kAXErrorAttributeUnsupported, false)
                .expect_err("missing or unchanged observations do not prove non-delivery");
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::DeliveryUncertain
        );
        assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
        assert_eq!(
            super::settle_uninformative_perform("AXOpen", kAXErrorAttributeUnsupported, true)
                .unwrap(),
            crate::actions::chain::chain_delivery::DeliveryOutcome::DeliveredVerified,
        );
    }

    #[test]
    fn raw_perform_cannot_fall_through_on_an_uninformative_return_code() {
        for code in [
            kAXErrorAttributeUnsupported,
            accessibility_sys::kAXErrorNoValue,
        ] {
            let error = classify("AXConfirm", super::PERFORM_API, code).unwrap_err();
            assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
            assert_eq!(
                error.disposition.delivery(),
                DeliveryDisposition::DeliveryUncertain
            );
            assert!(!classify("AXValue", "AXUIElementSetAttributeValue", code).unwrap());
        }
    }

    #[test]
    fn unsupported_action_remains_safe_non_delivery() {
        let result = classify("AXPress", "perform", kAXErrorActionUnsupported);
        assert!(!result.unwrap());
    }

    #[test]
    fn perform_codes_are_graded_by_how_much_they_prove() {
        use super::{PerformSignal, classify_perform};

        assert_eq!(
            classify_perform("AXPress", kAXErrorSuccess).unwrap(),
            PerformSignal::ReportedDelivered
        );
        assert_eq!(
            classify_perform("AXPress", kAXErrorActionUnsupported).unwrap(),
            PerformSignal::ReportedUnsupported
        );
        assert_eq!(
            classify_perform("AXOpen", kAXErrorAttributeUnsupported).unwrap(),
            PerformSignal::Uninformative
        );
    }

    #[test]
    fn capability_read_absence_does_not_prove_perform_non_delivery() {
        let error = super::classify_perform("AXScrollToVisible", kAXErrorFailure)
            .expect_err("generic failure does not prove an action was unsupported");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::DeliveryUncertain
        );
        assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
    }

    #[test]
    fn generic_failure_cannot_authorize_a_second_mutation() {
        for (operation, api) in [
            ("AXPress", super::PERFORM_API),
            ("AXValue", "AXUIElementSetAttributeValue"),
        ] {
            let error = classify(operation, api, kAXErrorFailure).unwrap_err();
            assert_eq!(
                error.disposition,
                agent_desktop_core::DeliverySemantics::uncertain()
            );
            assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
            assert!(
                error
                    .suggestion
                    .unwrap()
                    .contains("Inspect the target state")
            );
        }
    }

    #[test]
    fn invalid_element_is_stale_and_safe_to_retry_with_a_fresh_ref() {
        let errors = [
            classify("AXPress", "perform", kAXErrorInvalidUIElement)
                .expect_err("stale element must fail closed"),
            super::classify_perform("AXOpen", kAXErrorInvalidUIElement)
                .expect_err("a stale element must still fail closed"),
        ];

        for error in errors {
            assert_eq!(error.code, ErrorCode::StaleRef);
            assert_eq!(
                error.disposition.delivery(),
                DeliveryDisposition::NotDelivered
            );
            assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
        }
    }

    #[test]
    fn api_disabled_remains_permission_denied_without_probe() {
        let error = classify("AXPress", "perform", kAXErrorAPIDisabled).unwrap_err();
        assert_eq!(error.code, ErrorCode::PermDenied);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }

    #[test]
    fn cannot_complete_reports_uncertainty_without_an_extra_read() {
        let error = classify("AXValue", "set", kAXErrorCannotComplete).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::DeliveryUncertain
        );
        assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
        assert!(
            error
                .suggestion
                .as_deref()
                .unwrap()
                .contains("Inspect the target state")
        );
    }
}
