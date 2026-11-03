use super::select_exclusive::{
    exclusive_verdict, needs_replacement, replace_with_only, selected_count,
};
use super::select_verify::read_verification;
use crate::actions::context::Target;
use crate::tree::AtspiElement;
use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::click::{observed_of, refusal};
use crate::actions::toggle_state::{Flag, drive_to};
use crate::actions::write::mutation::WriteReply;

pub(super) fn deliver(
    toggle: bool,
    selected: Option<bool>,
    count: impl FnOnce() -> Option<Option<i32>>,
    invoke: impl FnOnce() -> Result<WriteReply, AdapterError>,
    observe: impl FnOnce() -> Result<Option<bool>, AdapterError>,
) -> Result<DeliveryOutcome, AdapterError> {
    if toggle && selected == Some(true) {
        match count() {
            Some(Some(count)) if count > 1 => return Ok(DeliveryOutcome::NotDelivered),
            None | Some(Some(1)) => {}
            _ => {
                return Err(refusal(
                    ErrorCode::ActionFailed,
                    "The container's exclusive selection could not be confirmed before the action",
                    serde_json::json!({ "selection": "unread" }),
                ));
            }
        }
    }
    let outcome = if toggle {
        drive_to(true, Flag::of(selected), invoke, || Flag::Unknown)?
    } else {
        match invoke()? {
            WriteReply::Absent => DeliveryOutcome::NotDelivered,
            WriteReply::Done => DeliveryOutcome::Delivered(Observed::Unread),
        }
    };
    match outcome {
        DeliveryOutcome::Delivered(_) => Ok(DeliveryOutcome::Delivered(observed_of(observe()?))),
        DeliveryOutcome::Satisfied => match observe()? {
            Some(true) => Ok(DeliveryOutcome::Satisfied),
            _ => Err(refusal(
                ErrorCode::ActionFailed,
                "The requested selection was not observed before the action",
                serde_json::json!({ "selection": "unconfirmed" }),
            )),
        },
        other => Ok(other),
    }
}

pub(super) fn keep_only_the_item(
    target: &Target<'_>,
    holder: &Target<'_>,
    item: &AtspiElement,
    display_value: &str,
) -> Result<Option<bool>, AdapterError> {
    let count = selected_count(holder);
    if !needs_replacement(count) {
        return Ok(exclusive_verdict(count));
    }
    replace_with_only(holder, item).map_err(|error| {
        if error.disposition == DeliverySemantics::not_delivered() {
            error.with_disposition(DeliverySemantics::delivered_unverified())
        } else {
            error
        }
    })?;
    let reread = read_verification(target.bus, target, item, display_value, Some(holder));
    Ok(match reread {
        Some(true) => exclusive_verdict(selected_count(holder)),
        other => other,
    })
}

#[cfg(test)]
#[path = "select_verb_tests.rs"]
mod tests;
