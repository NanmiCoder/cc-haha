use super::{ChainStep, build_step, exhaustion_disposition, record_step_outcome};
use crate::actions::chain::chain_delivery::DeliveryOutcome;
use agent_desktop_core::MouseButton;
use agent_desktop_core::actions::step_mechanism::StepMechanism;

#[test]
fn build_step_tags_mechanism_and_verified_on_success() {
    let step = ChainStep::SetBool {
        attr: "AXSelected",
        value: true,
    };
    let built = build_step(&step, DeliveryOutcome::DeliveredVerified);
    assert_eq!(built.mechanism(), Some(StepMechanism::SemanticApi));
    assert_eq!(built.verified(), Some(true));
}

#[test]
fn build_step_skipped_does_not_tag_verified() {
    let step = ChainStep::SetBool {
        attr: "AXSelected",
        value: true,
    };
    let built = build_step(&step, DeliveryOutcome::NotDelivered);
    assert_eq!(built.mechanism(), Some(StepMechanism::SemanticApi));
    assert!(built.verified().is_none());
}

#[test]
fn satisfied_without_delivery_stops_fallback_and_is_skipped_verified() {
    let step = ChainStep::Action("AlreadySatisfied");
    let mut steps = Vec::new();

    assert!(record_step_outcome(
        &mut steps,
        &step,
        DeliveryOutcome::SatisfiedNoDelivery,
        false,
    ));
    assert!(matches!(
        steps[0].outcome,
        agent_desktop_core::ActionStepOutcome::Skipped
    ));
    assert_eq!(steps[0].verified(), Some(true));
}

#[test]
fn build_step_marks_delivered_unverified_explicitly() {
    let built = build_step(
        &ChainStep::Action("AXPress"),
        DeliveryOutcome::DeliveredUnverified,
    );

    assert_eq!(built.mechanism(), Some(StepMechanism::SemanticApi));
    assert_eq!(built.verified(), Some(false));
}

#[test]
fn native_list_press_success_stops_click_chain_before_other_mutations() {
    let rungs = [
        (
            ChainStep::Action("AXPress"),
            DeliveryOutcome::DeliveredUnverified,
        ),
        (
            ChainStep::Action("AXConfirm"),
            DeliveryOutcome::DeliveredVerified,
        ),
        (
            ChainStep::Action("AXOpen"),
            DeliveryOutcome::DeliveredVerified,
        ),
        (
            ChainStep::CGClick {
                button: MouseButton::Left,
                count: 1,
            },
            DeliveryOutcome::DeliveredUnverified,
        ),
    ];
    let mut calls = Vec::new();
    let mut steps = Vec::new();

    for (step, outcome) in &rungs {
        calls.push(match step {
            ChainStep::Action(name) => *name,
            ChainStep::CGClick { .. } => "CGClick",
            _ => "other",
        });
        if record_step_outcome(&mut steps, step, *outcome, false) {
            break;
        }
    }

    assert_eq!(calls, ["AXPress"]);
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0].verified(), Some(false));
}

#[test]
fn idempotent_chain_continues_after_unverified_delivery() {
    let step = ChainStep::SetDynamic { attr: "AXValue" };
    let mut steps = Vec::new();

    assert!(!record_step_outcome(
        &mut steps,
        &step,
        DeliveryOutcome::DeliveredUnverified,
        true,
    ));
    assert_eq!(steps[0].verified(), Some(false));
}

#[test]
fn non_idempotent_chain_stops_after_unverified_delivery() {
    let step = ChainStep::Action("AXPress");
    let mut steps = Vec::new();

    assert!(record_step_outcome(
        &mut steps,
        &step,
        DeliveryOutcome::DeliveredUnverified,
        false,
    ));
}

#[test]
fn exhaustion_after_unverified_delivery_reports_delivered_unverified() {
    let mut steps = Vec::new();
    assert!(!record_step_outcome(
        &mut steps,
        &ChainStep::FocusThenClearByKeyboard,
        DeliveryOutcome::DeliveredUnverified,
        true,
    ));
    assert!(!record_step_outcome(
        &mut steps,
        &ChainStep::SetDynamic { attr: "AXValue" },
        DeliveryOutcome::NotDelivered,
        true,
    ));

    let error = super::exhaustion_error(&steps, "Inspect the current state");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::ActionFailed);
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Inspect the current state")
    );
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::delivered_unverified()
    );
}

#[test]
fn exhaustion_without_any_delivery_reports_not_delivered() {
    let mut steps = Vec::new();
    assert!(!record_step_outcome(
        &mut steps,
        &ChainStep::Action("AXPress"),
        DeliveryOutcome::NotDelivered,
        false,
    ));

    assert_eq!(
        exhaustion_disposition(&steps),
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert_eq!(
        exhaustion_disposition(&[]),
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}

#[test]
fn value_writes_stop_fallback_without_claiming_verification() {
    for definition in [
        &crate::actions::chain::chain_defs::SET_VALUE_CHAIN,
        &crate::actions::chain::chain_defs::CLEAR_CHAIN,
    ] {
        for step in definition.steps {
            let mut steps = Vec::new();
            assert!(record_step_outcome(
                &mut steps,
                step,
                DeliveryOutcome::DeliveredUnverified,
                definition.continue_after_unverified_delivery
            ));
            assert_eq!(steps[0].verified(), Some(false));
            assert!(!record_step_outcome(
                &mut Vec::new(),
                step,
                DeliveryOutcome::NotDelivered,
                definition.continue_after_unverified_delivery
            ));
        }
    }
}

#[test]
fn later_step_failure_retains_earlier_delivery() {
    use agent_desktop_core::{AdapterError, DeliverySemantics};
    let steps = [build_step(
        &ChainStep::SetDynamic { attr: "AXValue" },
        DeliveryOutcome::DeliveredUnverified,
    )];
    let error = AdapterError::timeout("later step failed")
        .with_disposition(DeliverySemantics::not_delivered());
    assert_eq!(
        super::after_steps(&steps, error).disposition,
        DeliverySemantics::delivered_unverified()
    );
    let uncertain = AdapterError::timeout("later step uncertain")
        .with_disposition(DeliverySemantics::uncertain());
    assert_eq!(
        super::after_steps(&steps, uncertain).disposition,
        DeliverySemantics::uncertain()
    );
}

#[test]
fn a_press_observed_to_change_nothing_reaches_the_selection_fallback() {
    let rungs = [
        (
            ChainStep::Action("AXPress"),
            DeliveryOutcome::DeliveredWithoutEffect,
        ),
        (ChainStep::Action("AXOpen"), DeliveryOutcome::NotDelivered),
        (
            ChainStep::CustomWithDeadline {
                label: "select_within_container",
                func: crate::actions::select::container_select::select_within_container,
            },
            DeliveryOutcome::DeliveredVerified,
        ),
    ];
    let mut calls = Vec::new();
    let mut steps = Vec::new();

    for (step, outcome) in &rungs {
        calls.push(match step {
            ChainStep::Action(name) => *name,
            ChainStep::CustomWithDeadline { label, .. } => *label,
            _ => "other",
        });
        if record_step_outcome(&mut steps, step, *outcome, false) {
            break;
        }
    }

    assert_eq!(calls, ["AXPress", "AXOpen", "select_within_container"]);
    assert_eq!(steps[0].verified(), Some(false));
    assert!(
        matches!(
            steps[0].outcome,
            agent_desktop_core::ActionStepOutcome::Succeeded
        ),
        "the press did reach the application and must not be reported as skipped"
    );
    assert_eq!(steps[2].verified(), Some(true));
}
