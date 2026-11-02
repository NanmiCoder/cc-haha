use super::*;

fn state(value: Option<&str>) -> ElementState {
    ElementState {
        role: "textfield".into(),
        states: vec![],
        value: value.map(str::to_string),
        enabled: None,
        hidden: None,
        offscreen: None,
    }
}

fn execution_result(verifications: &[Option<bool>]) -> ActionResult {
    let steps = verifications
        .iter()
        .map(|verified| {
            let step = ActionStep::succeeded("Step");
            match verified {
                Some(value) => step.with_verified(*value),
                None => step,
            }
        })
        .collect();
    ActionResult::from_execution(&Action::Click, steps)
}

#[test]
fn delivered_unverified_constructor_is_explicit() {
    assert_eq!(
        ActionResult::delivered_unverified("click").disposition(),
        DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn satisfied_without_delivery_is_successful_and_safe_to_repeat() {
    let result = ActionResult::satisfied_without_delivery("check").with_steps(vec![
        ActionStep::skipped("AlreadyInState").with_verified(true),
    ]);

    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["disposition"]["delivery"], "not_delivered");
    assert_eq!(json["disposition"]["retry"], "safe");
}

#[test]
fn verification_cannot_turn_a_no_op_into_claimed_delivery() {
    let result = ActionResult::satisfied_without_delivery("check").with_verified_delivery();

    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
}

#[test]
fn verified_action_uses_verified_delivery() {
    assert_eq!(
        ActionResult::delivered_unverified("click")
            .with_verified_delivery()
            .disposition(),
        DeliverySemantics::delivered_verified()
    );
}

#[test]
fn unavailable_verification_preserves_no_delivery_and_demotes_verified_delivery() {
    let satisfied = ActionResult::satisfied_without_delivery("clear").with_unverified_delivery();
    assert_eq!(satisfied.disposition(), DeliverySemantics::not_delivered());
    let delivered = ActionResult::delivered_unverified("set-value")
        .with_verified_delivery()
        .with_unverified_delivery();
    assert_eq!(
        delivered.disposition(),
        DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn json_without_disposition_is_rejected() {
    let value = serde_json::json!({ "action": "click" });

    assert!(serde_json::from_value::<ActionResult>(value).is_err());
}

#[test]
fn successful_action_rejects_unknown_and_uncertain_dispositions() {
    for delivery in ["unknown", "delivery_uncertain"] {
        let retry = if delivery == "unknown" {
            "unknown"
        } else {
            "unsafe"
        };
        let value = serde_json::json!({
            "action": "click",
            "disposition": {
                "delivery": delivery,
                "retry": retry
            }
        });

        assert!(serde_json::from_value::<ActionResult>(value).is_err());
    }
}

#[test]
fn successful_action_deserializes_satisfied_without_delivery() {
    let value = serde_json::json!({
        "action": "check",
        "disposition": {
            "delivery": "not_delivered",
            "retry": "safe"
        }
    });

    let result: ActionResult = serde_json::from_value(value).unwrap();
    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
}

#[test]
fn execution_without_succeeded_steps_is_satisfied_without_delivery() {
    let steps = vec![ActionStep::skipped("AlreadyInState").with_verified(true)];
    let result = ActionResult::from_execution(&Action::Check, steps);

    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
    assert_eq!(result.steps.len(), 1);
    assert!(result.post_state.is_none());
}

#[test]
fn execution_derives_disposition_from_succeeded_step_evidence() {
    for (verifications, expected) in [
        (vec![Some(true)], DeliverySemantics::delivered_verified()),
        (vec![Some(false)], DeliverySemantics::delivered_unverified()),
        (
            vec![Some(true), None],
            DeliverySemantics::delivered_verified(),
        ),
        (vec![None], DeliverySemantics::delivered_unverified()),
        (
            vec![Some(true), Some(false)],
            DeliverySemantics::delivered_unverified(),
        ),
    ] {
        assert_eq!(execution_result(&verifications).disposition(), expected);
    }
}

#[test]
fn execution_attaches_post_state_without_changing_serialization() {
    let steps = vec![ActionStep::succeeded("AXValue").with_verified(false)];
    let post_state = state(Some("done"));
    let actual = ActionResult::from_execution(&Action::SetValue("done".into()), steps.clone())
        .with_state(post_state.clone());
    let expected = ActionResult::delivered_unverified("set-value")
        .with_steps(steps)
        .with_state(post_state);

    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn verified_text_value_does_not_claim_application_commit() {
    let result = ActionResult::from_execution(
        &Action::SetValue("8".into()),
        vec![ActionStep::succeeded("AXValue").with_verified(true)],
    );
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_verified()
    );
    let details = result.details.unwrap();
    assert_eq!(details["verification_scope"], "element_value");
    assert_eq!(details["application_commit"], "not_verified");
}
