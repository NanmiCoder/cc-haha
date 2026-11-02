use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::mutation::WriteReply;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::chain::chain_rung::Rung;

pub(crate) const VALUE_INTERFACE: &str = "org.a11y.atspi.Value";
pub(crate) const VALUE_LABEL: &str = "Value.CurrentValue";

pub(crate) trait NumericPort {
    fn set(&self, value: f64) -> Result<WriteReply, AdapterError>;
    fn stored(&self) -> Option<f64>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Plan {
    pub(crate) value: f64,
    pub(crate) readback_proves_commit: bool,
}

fn invalid(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
        .with_disposition(DeliverySemantics::not_delivered())
}

fn whole(number: f64) -> bool {
    number.fract() == 0.0
}

pub(crate) fn plan(
    request: &str,
    spin_button: bool,
    increment: Option<f64>,
) -> Result<Plan, AdapterError> {
    let value = request
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .ok_or_else(|| invalid("The value is not a finite number"))?;
    let increment = increment.filter(|step| *step > 0.0);
    Ok(Plan {
        value,
        readback_proves_commit: whole(value) || !spin_button || increment.is_some(),
    })
}

fn agrees(stored: f64, requested: f64) -> bool {
    agent_desktop_core::value_matches("slider", &requested.to_string(), Some(&stored.to_string()))
}

fn write_ignored() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The control still holds its old value, so the write was not applied",
    )
    .with_suggestion("Operate the control with click or key presses instead")
    .with_details(serde_json::json!({ "cause": "write_ignored" }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn read_only() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The control does not accept a value write",
    )
    .with_suggestion("Operate the control with click or key presses instead")
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn write_rungs(port: &dyn NumericPort, plan: Plan) -> Vec<Rung<'_>> {
    let write = move || {
        let before = port.stored();
        if port.set(plan.value)? == WriteReply::Absent {
            return Err(read_only());
        }
        let observed = match port.stored() {
            _ if !plan.readback_proves_commit => Observed::Unread,
            None => Observed::Unread,
            Some(stored) if agrees(stored, plan.value) => Observed::Matched,
            Some(stored) if before.is_some_and(|old| agrees(stored, old)) => {
                return Err(write_ignored());
            }
            Some(_) => Observed::Unchanged,
        };
        Ok(DeliveryOutcome::Delivered(observed))
    };
    vec![Rung {
        label: VALUE_LABEL,
        run: Box::new(write),
    }]
}

#[cfg(test)]
#[path = "numeric_write_tests.rs"]
mod tests;
