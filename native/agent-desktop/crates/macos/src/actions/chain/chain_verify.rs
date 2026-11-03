use agent_desktop_core::AdapterError;

pub(crate) fn increment_deadline_error(start: f64, current: f64, target: f64) -> AdapterError {
    partial_mutation_disposition(
        AdapterError::timeout("Chain deadline expired while stepping the value toward the target")
        .with_suggestion(
            "Re-read the element value before retrying; increase --timeout-ms for slow controls.",
        )
        .with_details(serde_json::json!({
            "kind": "chain_deadline",
            "value_before": start,
            "value_at_timeout": current,
            "target": target,
            "mutated": (current - start).abs() >= f64::EPSILON,
        })),
        start,
        current,
    )
}

pub(crate) fn increment_step_limit_error(start: f64, current: f64, target: f64) -> AdapterError {
    partial_mutation_disposition(AdapterError::new(
        agent_desktop_core::ErrorCode::ActionFailed,
        "Chain step limit was reached while stepping the value toward the target",
    )
        .with_suggestion(
            "Re-read the element value before retrying; the control may expose a step size too small for the requested target.",
        )
        .with_details(serde_json::json!({
            "kind": "chain_step_limit",
            "value_before": start,
            "value_at_limit": current,
            "target": target,
            "mutated": (current - start).abs() >= f64::EPSILON,
        })), start, current)
}

fn partial_mutation_disposition(error: AdapterError, start: f64, current: f64) -> AdapterError {
    let disposition = if (current - start).abs() >= f64::EPSILON {
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    } else {
        agent_desktop_core::DeliverySemantics::not_delivered()
    };
    error.with_disposition(disposition)
}

pub(crate) fn bool_write_had_effect(attr: &str, expected: bool, observed: Option<bool>) -> bool {
    !matches!(
        attr,
        "AXExpanded" | "AXDisclosing" | "AXSelected" | "AXFocused"
    ) || observed == Some(expected)
}

pub(crate) fn dynamic_write_had_effect(
    attr: &str,
    role: Option<&str>,
    expected: &str,
    observed: Option<&str>,
) -> bool {
    attr == "AXValue" && agent_desktop_core::value_matches(role.unwrap_or(""), expected, observed)
}

#[cfg(test)]
mod tests {
    use super::{
        bool_write_had_effect, dynamic_write_had_effect, increment_deadline_error,
        increment_step_limit_error,
    };

    #[test]
    fn increment_deadline_error_is_timeout_and_reports_partial_mutation() {
        let err = increment_deadline_error(0.0, 37.0, 80.0);

        assert_eq!(err.code, agent_desktop_core::ErrorCode::Timeout);
        assert_eq!(
            err.disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
        let details = err.details.expect("details must carry the observed state");
        assert_eq!(details["value_before"], 0.0);
        assert_eq!(details["value_at_timeout"], 37.0);
        assert_eq!(details["target"], 80.0);
        assert_eq!(details["mutated"], true);
        assert!(err.suggestion.is_some());
    }

    #[test]
    fn increment_deadline_error_reports_unmutated_state() {
        let err = increment_deadline_error(5.0, 5.0, 9.0);

        assert_eq!(
            err.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
        let details = err.details.unwrap();
        assert_eq!(details["mutated"], false);
        assert_eq!(details["kind"], "chain_deadline");
    }

    #[test]
    fn increment_step_limit_error_reports_partial_mutation() {
        let err = increment_step_limit_error(0.0, 1024.0, 5000.0);

        assert_eq!(err.code, agent_desktop_core::ErrorCode::ActionFailed);
        assert_eq!(
            err.disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
        let details = err.details.unwrap();
        assert_eq!(details["kind"], "chain_step_limit");
        assert_eq!(details["value_at_limit"], 1024.0);
        assert_eq!(details["mutated"], true);
    }

    #[test]
    fn ax_value_write_requires_readback_match() {
        assert!(!dynamic_write_had_effect(
            "AXValue",
            Some("textfield"),
            "",
            Some("unchanged")
        ));
        assert!(dynamic_write_had_effect(
            "AXValue",
            Some("textfield"),
            "",
            Some("")
        ));
    }

    #[test]
    fn missing_readback_never_verifies_a_write() {
        assert!(!dynamic_write_had_effect(
            "AXSelected",
            Some("AXCheckBox"),
            "true",
            None
        ));
        assert!(!dynamic_write_had_effect(
            "AXValue",
            Some("AXSecureTextField"),
            "secret",
            None
        ));
    }

    #[test]
    fn bool_state_writes_require_readback_match_for_stateful_attrs() {
        assert!(bool_write_had_effect("AXExpanded", true, Some(true)));
        assert!(!bool_write_had_effect("AXExpanded", true, Some(false)));
        assert!(!bool_write_had_effect("AXExpanded", false, None));
        assert!(bool_write_had_effect("AXFoo", true, None));
    }

    #[test]
    fn numeric_value_write_matches_reformatted_readback() {
        assert!(dynamic_write_had_effect(
            "AXValue",
            Some("slider"),
            "50",
            Some("50.00")
        ));
        assert!(dynamic_write_had_effect(
            "AXValue",
            Some("incrementor"),
            "3",
            Some("3")
        ));
        assert!(dynamic_write_had_effect(
            "AXValue",
            Some("slider"),
            "50",
            Some("50.0000004")
        ));
        assert!(!dynamic_write_had_effect(
            "AXValue",
            Some("slider"),
            "50",
            Some("12.00")
        ));
    }
}
