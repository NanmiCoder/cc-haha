use std::time::Duration;

use agent_desktop_core::{Action, ActionResult, AdapterError, ErrorCode};
use serde_json::json;

use super::action_call::resolve_verb;
use super::click::{
    POLL_STEP, POPUP_SETTLE, POPUP_STEP, invoke_verb, names_of, opens_popup, poll_until,
    popup_inner, refusal, run_single_rung,
};
use super::context::Target;
use super::toggle_state::{Flag, drive_to};
use crate::tree::capabilities::action_names::verbs_for;
use crate::tree::capabilities::action_read::NodeView;
use crate::tree::vocabulary::state_bits::{EXPANDABLE, EXPANDED, HAS_POPUP};

const DISCLOSURE_SETTLE: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DisclosureFacts {
    pub(super) expandable: Option<bool>,
    pub(super) expanded: Option<bool>,
    pub(super) has_popup: Option<bool>,
}

impl DisclosureFacts {
    fn of(view: &NodeView) -> Self {
        Self {
            expandable: view.state(EXPANDABLE),
            expanded: view.state(EXPANDED),
            has_popup: view.state(HAS_POPUP),
        }
    }
}

pub(super) fn plan_disclosure(
    facts: DisclosureFacts,
    action: &Action,
) -> Result<Flag, AdapterError> {
    let (Some(expandable), Some(expanded)) = (facts.expandable, facts.expanded) else {
        return Err(refusal(
            ErrorCode::ActionFailed,
            "The expanded state of the element could not be read completely",
            json!({ "expanded": "unread" }),
        ));
    };
    if !(expandable || expanded || facts.has_popup == Some(true)) {
        return Err(refusal(
            ErrorCode::ActionNotSupported,
            format!("The element is a leaf and cannot take {}", action.name()),
            json!({ "expandable": false }),
        ));
    }
    Ok(Flag::of(Some(expanded)))
}

fn read_expanded(view: &NodeView) -> Flag {
    Flag::of(view.state(EXPANDED))
}

pub(crate) fn set_expanded(
    target: &Target<'_>,
    expanded: bool,
) -> Result<ActionResult, AdapterError> {
    let action = if expanded {
        Action::Expand
    } else {
        Action::Collapse
    };
    let view = target.view()?;
    let current = plan_disclosure(DisclosureFacts::of(&view), &action)?;
    let names = names_of(&view)?;
    let verbs = verbs_for(&action);
    let (budget, step) = if opens_popup(&view) {
        (POPUP_SETTLE, POPUP_STEP)
    } else {
        (DISCLOSURE_SETTLE, POLL_STEP)
    };
    let inner = if current.is_wanted(expanded)
        || resolve_verb(names, verbs).is_some()
        || !opens_popup(&view)
    {
        None
    } else {
        popup_inner(target, verbs)?
    };
    let run = || {
        drive_to(
            expanded,
            current,
            || match &inner {
                Some(inner) => {
                    let child = inner.target(target)?;
                    let child_view = child.view()?;
                    let child_names = names_of(&child_view)?;
                    invoke_verb(&child, &action, child_names, verbs)
                }
                None => invoke_verb(target, &action, names, verbs),
            },
            || {
                poll_until(
                    target.deadline,
                    budget,
                    step,
                    || {
                        target
                            .view()
                            .map_or(Flag::Unknown, |after| read_expanded(&after))
                    },
                    |flag| flag.is_wanted(expanded),
                )
            },
        )
    };
    super::popup_verify::run(target, &view, Some(expanded), || {
        run_single_rung(action.name(), target.deadline, run)
    })
}

#[cfg(test)]
#[path = "disclosure_tests.rs"]
mod tests;
