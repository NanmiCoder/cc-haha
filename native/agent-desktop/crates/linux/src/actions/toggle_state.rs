use std::time::Duration;

use agent_desktop_core::{Action, ActionResult, AdapterError, ErrorCode};
use serde_json::json;

use super::chain::chain_delivery_outcome::DeliveryOutcome;
use super::chain::chain_observed::Observed;
use super::click::{POLL_STEP, invoke_verb, names_of, poll_until, refusal, run_single_rung};
use super::context::Target;
use super::write::mutation::WriteReply;
use crate::tree::capabilities::action_names::toggle_verbs;
use crate::tree::capabilities::action_read::NodeView;
use crate::tree::capabilities::capability_rules::carries_checked;
use crate::tree::vocabulary::role_numbers::TOGGLE_BUTTON;
use crate::tree::vocabulary::state_bits::{CHECKED, INDETERMINATE, PRESSED};

const TOGGLE_SETTLE: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Flag {
    On,
    Off,
    Unknown,
}

impl Flag {
    pub(super) fn of(value: Option<bool>) -> Self {
        match value {
            Some(true) => Self::On,
            Some(false) => Self::Off,
            None => Self::Unknown,
        }
    }

    pub(super) fn is_wanted(self, wanted: bool) -> bool {
        self == Self::of(Some(wanted))
    }
}

fn checked_flag(
    role: u32,
    checked: Option<bool>,
    pressed: Option<bool>,
    indeterminate: Option<bool>,
) -> Result<Flag, AdapterError> {
    if indeterminate == Some(true) {
        return Err(refusal(
            ErrorCode::ActionFailed,
            "The element is in the indeterminate state, so no checked state is known",
            json!({ "checked": "indeterminate" }),
        ));
    }
    if role != TOGGLE_BUTTON {
        return Ok(Flag::of(checked));
    }
    Ok(match (checked, pressed) {
        (Some(true), _) | (_, Some(true)) => Flag::On,
        (Some(false), Some(false)) => Flag::Off,
        _ => Flag::Unknown,
    })
}

fn read_flag(view: &NodeView) -> Result<Flag, AdapterError> {
    let role = view.role().ok_or_else(|| {
        refusal(
            ErrorCode::ActionFailed,
            "The role of the element could not be read",
            json!({ "role": "unread" }),
        )
    })?;
    checked_flag(
        role,
        view.state(CHECKED),
        view.state(PRESSED),
        view.state(INDETERMINATE),
    )
}

fn guard_role(role: Option<u32>, action: &Action) -> Result<(), AdapterError> {
    match role {
        Some(role) if carries_checked(role) => Ok(()),
        Some(_) => Err(refusal(
            ErrorCode::ActionNotSupported,
            format!("The role of the element cannot carry {}", action.name()),
            json!({ "role_cannot_be_checked": true }),
        )),
        None => Err(refusal(
            ErrorCode::ActionFailed,
            "The role of the element could not be read",
            json!({ "role": "unread" }),
        )),
    }
}

pub(super) fn drive_to(
    wanted: bool,
    current: Flag,
    invoke: impl FnOnce() -> Result<WriteReply, AdapterError>,
    read_after: impl FnOnce() -> Flag,
) -> Result<DeliveryOutcome, AdapterError> {
    if current == Flag::Unknown {
        return Err(refusal(
            ErrorCode::ActionFailed,
            "The state of the element could not be read before the action",
            json!({ "state": "unread" }),
        ));
    }
    if current.is_wanted(wanted) {
        return Ok(DeliveryOutcome::Satisfied);
    }
    match invoke()? {
        WriteReply::Absent => Ok(DeliveryOutcome::NotDelivered),
        WriteReply::Done => Ok(DeliveryOutcome::Delivered(match read_after() {
            after if after.is_wanted(wanted) => Observed::Matched,
            Flag::Unknown => Observed::Unread,
            _ => Observed::Unchanged,
        })),
    }
}

pub(crate) fn toggle(
    target: &Target<'_>,
    desired: Option<bool>,
) -> Result<ActionResult, AdapterError> {
    toggle_reporting(target, desired, false)
}

pub(super) fn toggle_reporting(
    target: &Target<'_>,
    desired: Option<bool>,
    clicked: bool,
) -> Result<ActionResult, AdapterError> {
    let action = match desired {
        None => Action::Toggle,
        Some(true) => Action::Check,
        Some(false) => Action::Uncheck,
    };
    let view = target.view()?;
    guard_role(view.role(), &action)?;
    let current = read_flag(&view)?;
    let names = names_of(&view)?;
    let verbs = toggle_verbs(desired);
    let wanted = desired.unwrap_or(current == Flag::Off);
    let run = || {
        drive_to(
            wanted,
            current,
            || invoke_verb(target, &action, names, verbs),
            || {
                poll_until(
                    target.deadline,
                    TOGGLE_SETTLE,
                    POLL_STEP,
                    || {
                        target
                            .view()
                            .ok()
                            .and_then(|after| read_flag(&after).ok())
                            .unwrap_or(Flag::Unknown)
                    },
                    |flag| flag.is_wanted(wanted),
                )
            },
        )
    };
    super::popup_verify::run(target, &view, Some(wanted), || {
        run_single_rung(
            if clicked {
                Action::Click.name()
            } else {
                action.name()
            },
            target.deadline,
            run,
        )
    })
}

#[cfg(test)]
#[path = "toggle_state_tests.rs"]
mod tests;
