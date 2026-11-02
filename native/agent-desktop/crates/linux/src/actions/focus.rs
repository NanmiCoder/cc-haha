use std::time::Duration;

use agent_desktop_core::{
    Action, ActionResult, AdapterError, DeliverySemantics, ErrorCode, InteractionPolicy,
};
use serde_json::json;

use super::chain::chain_def::ChainDef;
use super::chain::chain_delivery_outcome::DeliveryOutcome;
use super::chain::chain_rung::Rung;
use super::chain::execute_chain;
use super::click::{POLL_STEP, observed_of, poll_until};
use super::context::Target;
use super::write::mutation::{WriteKind, WriteReply};
use super::write::write_call::{Call, invoke};
use crate::tree::COMPONENT_INTERFACE;
use crate::tree::vocabulary::state_bits::FOCUSED;

const FOCUS_SETTLE: Duration = Duration::from_millis(500);
const GRAB_FOCUS_LABEL: &str = "Component.GrabFocus";
const GRAB_FOCUS_REJECTED: &str = "grab_focus_rejected";
const FOCUS_WINDOW_HINT: &str = "Use focus-window to focus the owning window. This application does not let accessibility clients move focus to an element inside it";

pub(super) fn focus_policy_gate(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if policy.allow_focus_steal {
        return Ok(());
    }
    Err(AdapterError::policy_denied_for_policy(
        "Focusing an element moves the keyboard focus of the application",
        policy,
    )
    .with_details(json!({ "foreground_effect": true })))
}

pub(super) fn corroborated(first: Option<bool>, second: Option<bool>) -> Option<bool> {
    match first {
        Some(true) => second,
        other => other,
    }
}

fn grab_rejected() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The application rejected Component.GrabFocus, so keyboard focus did not move to the element",
    )
    .with_suggestion(FOCUS_WINDOW_HINT)
    .with_details(json!({ "cause": GRAB_FOCUS_REJECTED }))
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn judge_focus(
    focused_before: Option<bool>,
    grab: impl FnOnce() -> Result<WriteReply, AdapterError>,
    observe: impl FnOnce() -> Option<bool>,
) -> Result<DeliveryOutcome, AdapterError> {
    if focused_before == Some(true) {
        return Ok(DeliveryOutcome::Satisfied);
    }
    match grab()? {
        WriteReply::Absent => Err(grab_rejected()),
        WriteReply::Done => Ok(DeliveryOutcome::Delivered(observed_of(observe()))),
    }
}

fn grab_focus(target: &Target<'_>) -> Result<WriteReply, AdapterError> {
    invoke(
        target,
        Call {
            interface: COMPONENT_INTERFACE,
            method: "GrabFocus",
            body: &(),
            kind: WriteKind::GrabFocus,
        },
    )
}

fn focus_read_back(target: &Target<'_>) -> Option<bool> {
    let read = || target.view().ok().and_then(|after| after.state(FOCUSED));
    let first = poll_until(target.deadline, FOCUS_SETTLE, POLL_STEP, read, |focused| {
        *focused == Some(true)
    });
    if first == Some(true) {
        std::thread::sleep(POLL_STEP);
    }
    corroborated(first, read())
}

pub(crate) fn focus(
    target: &Target<'_>,
    policy: InteractionPolicy,
) -> Result<ActionResult, AdapterError> {
    focus_policy_gate(policy)?;
    let focused_before = target.view()?.state(FOCUSED);
    let def = ChainDef {
        action: Action::SetFocus.name(),
        suggestion: FOCUS_WINDOW_HINT,
    };
    let run = || {
        judge_focus(
            focused_before,
            || grab_focus(target),
            || focus_read_back(target),
        )
    };
    let mut rungs = [Rung {
        label: GRAB_FOCUS_LABEL,
        run: Box::new(run),
    }];
    execute_chain(&def, &mut rungs, target.deadline)
}

#[cfg(test)]
#[path = "focus_tests.rs"]
mod tests;
