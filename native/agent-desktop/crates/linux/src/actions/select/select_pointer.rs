use agent_desktop_core::{
    ActionResult, ActionStep, AdapterError, DeliverySemantics, InteractionLease, InteractionPolicy,
    KeyCombo, StepMechanism,
};
use serde_json::json;

use super::select_index::UNPROVEN_INDEX_KIND;
use crate::actions::chain::chain_delivery_outcome::DeliveryOutcome;
use crate::actions::chain::chain_observed::Observed;
use crate::actions::chain::chain_step::verified_of;
use crate::actions::select::unchanged_is_ignored;
use crate::input::physical::target_keyboard::press_key_global_steps;
use crate::input::physical::target_pointer::{ClickSpec, click_steps};
use crate::input::physical::target_world::LiveWorld;
use crate::system::SharedBus;
use crate::tree::AtspiElement;

const SEMANTIC_ROUTE: &str = "Selection.SelectChild";
const POINTER_ROUTE: &str = "XTEST.click";

/// The pointer and the keys a headed select uses once no semantic route can
/// carry it. A headless select has none, so it never holds one.
pub(crate) trait Pointer {
    fn click(&self, element: &AtspiElement) -> Result<Vec<ActionStep>, AdapterError>;
    fn escape(&self) -> Result<Vec<ActionStep>, AdapterError>;
}

pub(crate) struct LivePointer<'a> {
    pub(crate) bus: &'a SharedBus,
    pub(crate) lease: &'a InteractionLease,
    pub(crate) policy: InteractionPolicy,
}

impl LivePointer<'_> {
    fn world(&self) -> LiveWorld<'_> {
        LiveWorld {
            bus: self.bus,
            lease: self.lease,
        }
    }
}

impl Pointer for LivePointer<'_> {
    fn click(&self, element: &AtspiElement) -> Result<Vec<ActionStep>, AdapterError> {
        click_steps(
            &self.world(),
            element,
            ClickSpec::left(1, None),
            self.policy,
            self.lease.deadline(),
        )
    }

    fn escape(&self) -> Result<Vec<ActionStep>, AdapterError> {
        let combo = KeyCombo {
            key: "escape".to_owned(),
            modifiers: Vec::new(),
        };
        press_key_global_steps(&self.world(), &combo, self.lease.deadline())
    }
}

/// The answer for a select whose wanted choice is already the one in place:
/// the pointer click is skipped, and the read-back that showed it verifies it.
pub(crate) fn already_satisfied() -> ActionResult {
    let step = ActionStep::skipped(POINTER_ROUTE)
        .with_mechanism(StepMechanism::PhysicalSynthetic)
        .with_verified(true);
    ActionResult::satisfied_without_delivery("select").with_steps(vec![step])
}

pub(in crate::actions) fn is_unproven_index(error: &AdapterError) -> bool {
    error.disposition == DeliverySemantics::not_delivered()
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .is_some_and(|kind| kind == UNPROVEN_INDEX_KIND)
}

fn record_refusal(mut result: ActionResult, refusal: &AdapterError) -> ActionResult {
    result.steps.insert(
        0,
        ActionStep::skipped(SEMANTIC_ROUTE).with_mechanism(StepMechanism::SemanticApi),
    );
    result.details.get_or_insert_with(|| json!({}))["semantic_refusal"] = json!({
        "code": refusal.code,
        "message": refusal.message,
        "details": refusal.details,
    });
    result
}

/// A select whose semantic route was refused because the toolkit's index
/// cannot be mapped to the intended row goes on with the pointer when the
/// request holds one. Every other answer stands, and so does every answer to a
/// headless request.
pub(in crate::actions) fn after_unproven_index(
    pointer: Option<&dyn Pointer>,
    semantic: impl FnOnce() -> Result<ActionResult, AdapterError>,
    by_pointer: impl FnOnce(&dyn Pointer) -> Result<ActionResult, AdapterError>,
) -> Result<ActionResult, AdapterError> {
    match (semantic(), pointer) {
        (Err(refusal), Some(pointer)) if is_unproven_index(&refusal) => {
            by_pointer(pointer).map(|result| record_refusal(result, &refusal))
        }
        (answer, _) => answer,
    }
}

/// The answer for a select the pointer carried: delivered, and verified
/// exactly when the selection reads back as the wanted one. A read-back that
/// shows the old choice is the same failure a semantic write gets.
pub(in crate::actions) fn by_pointer_result(
    mut steps: Vec<ActionStep>,
    observed: Observed,
) -> Result<ActionResult, AdapterError> {
    unchanged_is_ignored(DeliveryOutcome::Delivered(observed))?;
    let verified = verified_of(observed);
    if let Some(last) = steps.last_mut() {
        last.verified = verified;
    }
    let result = ActionResult::delivered_unverified("select").with_steps(steps);
    Ok(match verified {
        Some(true) => result.with_verified_delivery(),
        _ => result,
    })
}

pub(in crate::actions) fn pointer_required() -> AdapterError {
    AdapterError::policy_denied_for_policy(
        "Selecting this dropdown choice takes the pointer, which the interaction policy does not allow",
        InteractionPolicy::headless(),
    )
    .with_suggestion(
        "Run select again with --headed on X11: the pointer opens the dropdown and the choice is checked against the value it shows. A headless request and a Wayland session cannot open it.",
    )
    .with_details(json!({
        "kind": "pointer_required",
        "physical_delivery_started": false,
    }))
}

#[cfg(test)]
#[path = "select_pointer_tests.rs"]
mod tests;
