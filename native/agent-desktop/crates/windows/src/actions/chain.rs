//! Activation-chain engine for UIA pattern dispatch.
//!
//! Rung closures return a delivery outcome or `Err`. A genuine `Err` always
//! aborts the chain and never falls through to a later rung. Its disposition,
//! however, is not always the classifier's: a chain that opts into continuing
//! after an unverified delivery can hard-error on a later rung after an
//! earlier one already mutated the control, so an `Err` raised once
//! `delivery_occurred` on the recorded steps is upgraded to
//! `delivered_unverified` before it leaves this function — the code,
//! message, suggestion and platform detail are left untouched. Only a clean
//! not-delivered outcome advances to the next rung. Policy-disallowed rungs
//! are skipped with no step recorded. Physical legs are built outside this
//! engine in `physical_click` and `physical_keyboard`, which record
//! `PhysicalSynthetic` steps. Every rung this engine runs uses the
//! `semantic_api` mechanism.

use agent_desktop_core::{
    ActionStep, ActionStepOutcome, AdapterError, Deadline, DeliverySemantics, ErrorCode,
    InteractionPolicy, StepMechanism,
};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use crate::actions::mutation::{classify_success, classify_write};
#[cfg(target_os = "windows")]
use crate::tree::element::UIAElement;
#[cfg(target_os = "windows")]
use crate::tree::properties::property_ids::TreeProperty;
#[cfg(target_os = "windows")]
use crate::tree::properties::read_one;
#[cfg(target_os = "windows")]
use uiautomation::patterns::UIInvokePattern;

pub(crate) const INVOKE_LABEL: &str = "InvokePattern.Invoke";
pub(crate) const ALREADY_LABEL: &str = "AlreadyInState";

/// Caps a verification poll window by the remaining action budget.
pub(crate) fn capped_verification_end(
    deadline: Deadline,
    cap: Duration,
) -> Result<Instant, AdapterError> {
    let remaining = deadline.remaining();
    if remaining.is_zero() {
        return Err(deadline.timeout_error());
    }
    let local = Instant::now() + cap;
    Ok(Instant::now()
        .checked_add(remaining)
        .map_or(local, |end| end.min(local)))
}

/// Per-rung delivery judgment recorded into an [`ActionStep`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeliveryOutcome {
    NotDelivered,
    /// Already-at-target arms (toggle / disclosure) construct this outcome.
    SatisfiedNoDelivery,
    DeliveredUnverified,
    DeliveredVerified,
    /// Delivered, but verification was withheld (secure / unreadable IsPassword).
    DeliveredUnobserved,
}

impl DeliveryOutcome {
    pub(crate) fn from_delivery(delivered: bool, verified: bool) -> Self {
        match (delivered, verified) {
            (false, _) => Self::NotDelivered,
            (true, false) => Self::DeliveredUnverified,
            (true, true) => Self::DeliveredVerified,
        }
    }

    /// Maps a delivered write's observation onto a chain outcome.
    ///
    /// `None` is the secure-field shape: the write landed and no value was
    /// re-read, so the step must not claim `verified: true` or `false`.
    pub(crate) fn from_observation(verified: Option<bool>) -> Self {
        match verified {
            Some(true) => Self::DeliveredVerified,
            Some(false) => Self::DeliveredUnverified,
            None => Self::DeliveredUnobserved,
        }
    }

    #[cfg(test)]
    pub(crate) fn was_delivered(self) -> bool {
        matches!(
            self,
            Self::DeliveredUnverified | Self::DeliveredVerified | Self::DeliveredUnobserved
        )
    }

    #[cfg(test)]
    pub(crate) fn was_verified(self) -> bool {
        matches!(self, Self::SatisfiedNoDelivery | Self::DeliveredVerified)
    }

    pub(crate) fn terminates_chain(self) -> bool {
        !matches!(self, Self::NotDelivered)
    }
}

/// Chain-level knobs shared by every action that runs through the engine.
pub(crate) struct ChainDef {
    pub(crate) suggestion: &'static str,
    pub(crate) continue_after_unverified_delivery: bool,
}

/// Click chain: Invoke first, Legacy default action second (A19-6, A2-2).
pub(crate) const CLICK_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot and retry, or target an element that advertises Invoke or a Legacy default action.",
    continue_after_unverified_delivery: false,
};

/// One rung whose runner is injected — the unit-test seam.
pub(crate) struct ChainRung<'a> {
    pub(crate) label: &'static str,
    pub(crate) requires_headed: bool,
    pub(crate) run: &'a mut dyn FnMut() -> Result<DeliveryOutcome, AdapterError>,
}

/// Runs gated rungs in order, recording a step for every attempted rung.
pub(crate) fn execute_chain(
    deadline: Deadline,
    def: &ChainDef,
    policy: InteractionPolicy,
    rungs: &mut [ChainRung<'_>],
) -> Result<Vec<ActionStep>, AdapterError> {
    let mut steps = Vec::new();
    for rung in rungs.iter_mut() {
        if let Err(expiry) = deadline.ensure_remaining() {
            return Err(expiry.with_disposition(exhaustion_disposition(&steps)));
        }
        if !rung_allowed(rung, policy) {
            continue;
        }
        let outcome = match (rung.run)() {
            Ok(outcome) => outcome,
            Err(error) => {
                return Err(if delivery_occurred(&steps) {
                    error.with_disposition(exhaustion_disposition(&steps))
                } else {
                    error
                });
            }
        };
        if record_step_outcome(
            &mut steps,
            rung.label,
            outcome,
            def.continue_after_unverified_delivery,
        ) {
            return Ok(steps);
        }
    }
    Err(
        AdapterError::new(ErrorCode::ActionFailed, "All chain steps exhausted")
            .with_disposition(exhaustion_disposition(&steps))
            .with_suggestion(def.suggestion),
    )
}

pub(crate) fn rung_allowed(rung: &ChainRung<'_>, policy: InteractionPolicy) -> bool {
    !rung.requires_headed || policy.is_headed()
}

/// Re-dispositions an error raised after a rung already mutated the control.
/// The caller has positive evidence of delivery, so the retry permission the
/// inner error carried no longer describes the world the caller is in.
pub(crate) fn after_delivery(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

pub(crate) fn delivery_occurred(steps: &[ActionStep]) -> bool {
    steps
        .iter()
        .any(|step| matches!(step.outcome, ActionStepOutcome::Succeeded))
}

pub(crate) fn exhaustion_disposition(steps: &[ActionStep]) -> DeliverySemantics {
    if delivery_occurred(steps) {
        DeliverySemantics::delivered_unverified()
    } else {
        DeliverySemantics::not_delivered()
    }
}

pub(crate) fn build_step(label: &'static str, outcome: DeliveryOutcome) -> ActionStep {
    let built = match outcome {
        DeliveryOutcome::NotDelivered => ActionStep::skipped(label),
        DeliveryOutcome::SatisfiedNoDelivery => ActionStep::skipped(label).with_verified(true),
        DeliveryOutcome::DeliveredUnobserved => ActionStep::succeeded(label),
        DeliveryOutcome::DeliveredUnverified => ActionStep::succeeded(label).with_verified(false),
        DeliveryOutcome::DeliveredVerified => ActionStep::succeeded(label).with_verified(true),
    };
    built.with_mechanism(StepMechanism::SemanticApi)
}

/// Records `outcome` and returns whether the chain should stop.
pub(crate) fn record_step_outcome(
    steps: &mut Vec<ActionStep>,
    label: &'static str,
    outcome: DeliveryOutcome,
    continue_after_unverified_delivery: bool,
) -> bool {
    steps.push(build_step(label, outcome));
    outcome.terminates_chain()
        && !(continue_after_unverified_delivery && outcome == DeliveryOutcome::DeliveredUnverified)
}

/// Skips `run` when `available` is false, recording a clean not-delivered
/// outcome instead of invoking a pattern the live read never confirmed.
/// Replaces the `if !available { return Ok(NotDelivered); } run()` closure
/// copy-pasted at every rung gate — callers with a compound guard combine it
/// into one `bool` before calling in (De Morgan, not two calls).
pub(crate) fn gated<'a>(
    available: bool,
    run: &'a mut dyn FnMut() -> Result<DeliveryOutcome, AdapterError>,
) -> impl FnMut() -> Result<DeliveryOutcome, AdapterError> + 'a {
    move || {
        if !available {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        run()
    }
}

/// Whether `InvokePattern` is advertised — the availability half of the
/// Click / Expand-Collapse / Toggle chains' shared Invoke fallback rung.
#[cfg(target_os = "windows")]
pub(crate) fn invoke_available(element: &UIAElement) -> bool {
    read_one(element, TreeProperty::InvokeAvailable).flag() == Some(true)
}

/// Invokes `InvokePattern` and classifies the write — the delivery half of
/// the shared Invoke fallback rung. Callers that need a [`DeliveryOutcome`]
/// directly (rather than an unverified bool to observe further) wrap this
/// with [`DeliveryOutcome::from_delivery`].
#[cfg(target_os = "windows")]
pub(crate) fn invoke_pattern_delivered(element: &UIAElement) -> Result<bool, AdapterError> {
    match element.0.get_pattern::<UIInvokePattern>() {
        Ok(pattern) => match pattern.invoke() {
            Ok(()) => classify_success(),
            Err(error) => classify_write("Invoke", INVOKE_LABEL, &error),
        },
        Err(error) => classify_write("get_pattern", INVOKE_LABEL, &error),
    }
}

#[cfg(test)]
#[path = "chain_tests.rs"]
mod tests;

/// Split from `chain_tests.rs`: this module owns the budget-expiry cases,
/// which assert what an expiry reports rather than what a rung does, and are
/// the only chain tests that depend on wall-clock time.
#[cfg(test)]
#[path = "chain_budget_tests.rs"]
mod budget_tests;

/// Split from `chain_tests.rs` for the per-file line cap: this module owns the
/// fallthrough policy the shipped value-write chain declares, as distinct from
/// the general engine mechanism `chain_tests.rs` exercises.
#[cfg(test)]
#[path = "chain_policy_tests.rs"]
mod policy_tests;
