use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, Deadline, DeliverySemantics, ErrorCode,
};
use serde_json::json;

use chain_step::{satisfied_step, semantic_step, skipped_step, verified_of};

use chain_def::ChainDef;
use chain_delivery_outcome::DeliveryOutcome;
use chain_rung::Rung;

pub(crate) mod chain_def;
pub(crate) mod chain_delivery_outcome;
pub(crate) mod chain_observed;
pub(crate) mod chain_rung;
pub(crate) mod chain_step;

const ABSENT_CAUSE: &str = "affordance_absent";

fn exhausted(def: &ChainDef, steps: &[ActionStep]) -> AdapterError {
    let tried: Vec<&str> = steps.iter().map(ActionStep::label).collect();
    let rungs: Vec<_> = tried
        .iter()
        .map(|label| json!({ "label": label, "outcome": "not_delivered", "cause": ABSENT_CAUSE }))
        .collect();
    AdapterError::new(
        ErrorCode::ActionFailed,
        "No step delivered the action: every step answered false or named an affordance the element does not carry",
    )
        .with_suggestion(def.suggestion)
        .with_details(json!({ "steps_tried": tried, "rungs": rungs }))
        .with_disposition(DeliverySemantics::not_delivered())
}

fn expired(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn execute_chain(
    def: &ChainDef,
    rungs: &mut [Rung<'_>],
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    let mut steps = Vec::new();
    for rung in rungs.iter_mut() {
        deadline.ensure_remaining().map_err(expired)?;
        match (rung.run)()? {
            DeliveryOutcome::NotDelivered => steps.push(skipped_step(rung.label)),
            DeliveryOutcome::Satisfied => {
                steps.push(satisfied_step(rung.label));
                return Ok(ActionResult::satisfied_without_delivery(def.action).with_steps(steps));
            }
            DeliveryOutcome::Delivered(observed) => {
                let verified = verified_of(observed);
                steps.push(semantic_step(rung.label, verified));
                let result = ActionResult::delivered_unverified(def.action).with_steps(steps);
                return Ok(match verified {
                    Some(true) => result.with_verified_delivery(),
                    _ => result,
                });
            }
        }
    }
    Err(exhausted(def, &steps))
}

#[cfg(test)]
#[path = "chain_tests.rs"]
mod tests;
