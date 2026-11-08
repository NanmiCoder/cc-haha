use std::time::{Duration, Instant};

use agent_desktop_core::{
    Action, ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode, NativeHandle,
};
use serde_json::json;

use super::action_call::{do_action, resolve_verb};
use super::chain::chain_def::ChainDef;
use super::chain::chain_delivery_outcome::DeliveryOutcome;
use super::chain::chain_observed::Observed;
use super::chain::chain_rung::Rung;
use super::chain::execute_chain;
use super::context::Target;
use super::toggle_state::toggle_reporting;
use super::write::mutation::WriteReply;
use crate::system::within;
use crate::tree::capabilities::action_names::{click_verbs, toggle_verbs, verbs_for};
use crate::tree::capabilities::action_read::{NodeView, read_node_view};
use crate::tree::capabilities::capability_rules::carries_checked;
use crate::tree::vocabulary::role_numbers::TOGGLE_BUTTON;
use crate::tree::vocabulary::state_bits::HAS_POPUP;
use crate::tree::{AtspiElement, atspi_element, element::ancestry, list_children};

pub(super) const POLL_STEP: Duration = Duration::from_millis(50);
pub(super) const POPUP_STEP: Duration = Duration::from_millis(50);
pub(super) const POPUP_SETTLE: Duration = Duration::from_millis(1500);
const CLICK_SETTLE: Duration = Duration::from_millis(300);
const INNER_TOGGLE_SCAN: usize = 4;
const CLICK_LABEL: &str = "Action.DoAction";
const SUGGESTION: &str =
    "Refresh the snapshot and inspect the element before deciding whether to retry.";

pub(super) fn poll_until<T>(
    deadline: Deadline,
    budget: Duration,
    step: Duration,
    mut read: impl FnMut() -> T,
    done: impl Fn(&T) -> bool,
) -> T {
    let end = Instant::now() + budget.min(deadline.remaining());
    loop {
        let value = read();
        let now = Instant::now();
        if done(&value) || now >= end {
            return value;
        }
        std::thread::sleep(step.min(end - now));
    }
}

pub(super) fn observed_of(change: Option<bool>) -> Observed {
    match change {
        Some(true) => Observed::Matched,
        Some(false) => Observed::Unchanged,
        None => Observed::Unread,
    }
}

pub(super) fn refusal(
    code: ErrorCode,
    message: impl Into<String>,
    details: serde_json::Value,
) -> AdapterError {
    AdapterError::new(code, message)
        .with_suggestion(SUGGESTION)
        .with_details(details)
        .with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn no_semantic_verb(action: &Action) -> AdapterError {
    refusal(
        ErrorCode::ActionNotSupported,
        format!(
            "The element advertises no action that carries {}",
            action.name()
        ),
        json!({ "semantic_verb": "absent" }),
    )
}

pub(super) fn names_of(view: &NodeView) -> Result<&[String], AdapterError> {
    view.action_names().ok_or_else(|| {
        refusal(
            ErrorCode::ActionFailed,
            "The action list of the element could not be read",
            json!({ "action_names": "unread" }),
        )
    })
}

pub(super) fn invoke_verb(
    target: &Target<'_>,
    action: &Action,
    names: &[String],
    verbs: &[&str],
) -> Result<WriteReply, AdapterError> {
    if resolve_verb(names, verbs).is_none() {
        return Err(no_semantic_verb(action));
    }
    do_action(target, names, verbs)
}

pub(super) fn deliver(
    reply: Result<WriteReply, AdapterError>,
    observe: impl FnOnce() -> Option<bool>,
) -> Result<DeliveryOutcome, AdapterError> {
    match reply? {
        WriteReply::Absent => Ok(DeliveryOutcome::NotDelivered),
        WriteReply::Done => Ok(DeliveryOutcome::Delivered(observed_of(observe()))),
    }
}

pub(super) fn run_single_rung(
    action: &'static str,
    deadline: Deadline,
    run: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
) -> Result<ActionResult, AdapterError> {
    let def = ChainDef {
        action,
        suggestion: SUGGESTION,
    };
    let mut rungs = [Rung {
        label: CLICK_LABEL,
        run: Box::new(run),
    }];
    execute_chain(&def, &mut rungs, deadline)
}

pub(super) struct Inner {
    handle: NativeHandle,
}

impl Inner {
    pub(super) fn target<'a>(&'a self, parent: &Target<'a>) -> Result<Target<'a>, AdapterError> {
        Ok(Target {
            bus: parent.bus,
            handle: &self.handle,
            element: atspi_element(&self.handle)?,
            deadline: parent.deadline,
        })
    }
}

fn is_inner_toggle(role: Option<u32>, has_verb: bool) -> bool {
    role == Some(TOGGLE_BUTTON) && has_verb
}

pub(super) fn popup_inner(
    target: &Target<'_>,
    verbs: &[&str],
) -> Result<Option<Inner>, AdapterError> {
    let connection = target.bus.get(target.deadline)?;
    let element = target.element;
    let children = within(target.deadline, async {
        list_children(connection.inner(), element).await
    })?;
    for (bus, path) in children.into_iter().take(INNER_TOGGLE_SCAN) {
        let mut child = AtspiElement::new(bus, path, element.pid());
        child.set_ancestry(ancestry::child(element, None));
        let handle = child.into_native_handle();
        let Ok(view) = read_node_view(target.bus, &handle, target.deadline) else {
            continue;
        };
        let has_verb = view
            .action_names()
            .is_some_and(|names| resolve_verb(names, verbs).is_some());
        if is_inner_toggle(view.role(), has_verb) {
            return Ok(Some(Inner { handle }));
        }
    }
    Ok(None)
}

pub(super) fn opens_popup(view: &NodeView) -> bool {
    view.state(HAS_POPUP) == Some(true)
}

fn toggles_in_place(role: Option<u32>, names: &[String]) -> bool {
    role.is_some_and(carries_checked) && resolve_verb(names, toggle_verbs(None)).is_some()
}

fn activate(target: &Target<'_>, action: &Action) -> Result<ActionResult, AdapterError> {
    let view = target.view()?;
    if matches!(action, Action::Click)
        && let Some(result) = super::native_menu::try_click(target, &view)?
    {
        return Ok(result);
    }
    let names = names_of(&view)?;
    if matches!(action, Action::Click)
        && crate::tree::capabilities::action_names::unsupported_entry_activation(
            view.role(),
            names,
            &crate::tree::live_read::live_offscreen::toolkit_of(
                target.bus,
                target.element,
                target.deadline,
            ),
        )
    {
        return Err(no_semantic_verb(action));
    }
    let verbs = match action {
        Action::Click => click_verbs(view.role()),
        _ => verbs_for(action),
    };
    let (budget, step) = if opens_popup(&view) {
        (POPUP_SETTLE, POPUP_STEP)
    } else {
        (CLICK_SETTLE, POLL_STEP)
    };
    let before = matches!(action, Action::RightClick).then(|| view.observation());
    let own_verb = resolve_verb(names, verbs).is_some();
    if matches!(action, Action::Click) && !own_verb && toggles_in_place(view.role(), names) {
        return toggle_reporting(target, None, true);
    }
    let inner = if own_verb || !opens_popup(&view) {
        None
    } else {
        popup_inner(target, verbs)?
    };
    let run = || {
        let reply = match &inner {
            Some(inner) => {
                let child = inner.target(target)?;
                let child_view = child.view()?;
                let child_names = names_of(&child_view)?;
                invoke_verb(&child, action, child_names, verbs)
            }
            None => invoke_verb(target, action, names, verbs),
        };
        deliver(reply, || {
            before.as_ref().and_then(|before| {
                poll_until(
                    target.deadline,
                    budget,
                    step,
                    || {
                        target
                            .view()
                            .ok()
                            .and_then(|after| after.observation().changed_since(before))
                    },
                    |change| *change == Some(true),
                )
            })
        })
    };
    if matches!(action, Action::Click) {
        super::popup_verify::run(target, &view, None, || {
            run_single_rung(action.name(), target.deadline, run)
        })
    } else {
        run_single_rung(action.name(), target.deadline, run)
    }
}

pub(crate) fn click(target: &Target<'_>) -> Result<ActionResult, AdapterError> {
    activate(target, &Action::Click)
}

pub(crate) fn right_click(target: &Target<'_>) -> Result<ActionResult, AdapterError> {
    activate(target, &Action::RightClick)
}

#[cfg(test)]
#[path = "click_tests.rs"]
mod tests;
