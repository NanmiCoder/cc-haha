use agent_desktop_core::actions::step_mechanism::StepMechanism;
use agent_desktop_core::{ActionStep, actions::interaction_policy::InteractionPolicy};
use agent_desktop_core::{AdapterError, ErrorCode};

use crate::actions::chain::chain_delivery::DeliveryOutcome;
use crate::tree::AXElement;

pub(crate) use super::chain::chain_context::ChainContext;
pub(crate) use super::chain::chain_def::ChainDef;
pub(crate) use super::chain::chain_step::ChainStep;

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::actions::chain::chain_step_exec::execute_step;

    pub(crate) fn execute_chain(
        el: &AXElement,
        def: &ChainDef,
        ctx: &ChainContext,
        policy: InteractionPolicy,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let total = def.steps.len();
        let mut steps = Vec::new();
        if let Some(pid) = crate::system::app::app_ops::pid_from_element(el, ctx.deadline) {
            crate::tree::properties::attributes::set_messaging_timeout(
                &crate::tree::element_for_pid(pid),
                ctx.deadline,
            )?;
        }
        crate::tree::properties::attributes::set_messaging_timeout(el, ctx.deadline)?;

        for (i, step) in def.steps.iter().enumerate() {
            ctx.ensure_budget()
                .map_err(|error| after_steps(&steps, error))?;
            if !step_allowed(step, policy) {
                continue;
            }
            let label = step_label(step);
            let outcome =
                execute_step(el, step, ctx, policy).map_err(|error| after_steps(&steps, error))?;
            let continue_unverified = def.continue_after_unverified_delivery;
            if record_step_outcome(&mut steps, step, outcome, continue_unverified) {
                tracing::debug!("chain: [{}/{}] {} -> success", i + 1, total, label);
                return Ok(steps);
            }
            tracing::debug!("chain: [{}/{}] {} -> skip", i + 1, total, label);
        }

        tracing::debug!("chain: all {total} steps exhausted");
        Err(exhaustion_error(&steps, def.suggestion))
    }

    pub(crate) fn exhaustion_error(steps: &[ActionStep], suggestion: &str) -> AdapterError {
        AdapterError::new(ErrorCode::ActionFailed, "All chain steps exhausted")
            .with_disposition(exhaustion_disposition(steps))
            .with_suggestion(suggestion)
    }

    pub(crate) fn after_steps(steps: &[ActionStep], error: AdapterError) -> AdapterError {
        let delivered = exhaustion_disposition(steps)
            == agent_desktop_core::DeliverySemantics::delivered_unverified();
        crate::actions::DeliveryTracker::from_delivered_units(usize::from(delivered))
            .annotate(error)
    }

    pub(crate) fn exhaustion_disposition(
        steps: &[ActionStep],
    ) -> agent_desktop_core::DeliverySemantics {
        let delivered = steps.iter().any(|step| {
            matches!(
                step.outcome,
                agent_desktop_core::ActionStepOutcome::Succeeded
            )
        });
        if delivered {
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        } else {
            agent_desktop_core::DeliverySemantics::not_delivered()
        }
    }

    pub(crate) fn step_mechanism(step: &ChainStep) -> StepMechanism {
        match step {
            ChainStep::CGClick { .. } | ChainStep::FocusThenClearByKeyboard => {
                StepMechanism::PhysicalSynthetic
            }
            _ => StepMechanism::SemanticApi,
        }
    }

    pub(crate) fn build_step(step: &ChainStep, outcome: DeliveryOutcome) -> ActionStep {
        let label = step_label(step);
        let mut built = match outcome {
            DeliveryOutcome::NotDelivered => ActionStep::skipped(label),
            DeliveryOutcome::SatisfiedNoDelivery => ActionStep::skipped(label).with_verified(true),
            DeliveryOutcome::DeliveredUnverified
            | DeliveryOutcome::DeliveredWithoutEffect
            | DeliveryOutcome::DeliveredVerified => ActionStep::succeeded(label),
        };
        built = built.with_mechanism(step_mechanism(step));
        if outcome.was_delivered() {
            built = built.with_verified(outcome.was_verified());
        }
        built
    }

    pub(crate) fn record_step_outcome(
        steps: &mut Vec<ActionStep>,
        step: &ChainStep,
        outcome: DeliveryOutcome,
        continue_after_unverified_delivery: bool,
    ) -> bool {
        steps.push(build_step(step, outcome));
        outcome.terminates_chain()
            && !(continue_after_unverified_delivery
                && outcome == DeliveryOutcome::DeliveredUnverified)
    }

    fn step_label(step: &ChainStep) -> &'static str {
        match step {
            ChainStep::Action(name) => name,
            ChainStep::SetBool { attr, .. } => attr,
            ChainStep::SetDynamic { attr } => attr,
            ChainStep::IncrementToDynamic => "IncrementToDynamic",
            ChainStep::FocusThenClearByKeyboard => "FocusThenClearByKeyboard",
            ChainStep::CustomWithDeadline { label, .. } => label,
            ChainStep::CGClick { .. } => "CGClick",
        }
    }

    pub(crate) fn step_allowed(step: &ChainStep, policy: InteractionPolicy) -> bool {
        !matches!(
            step,
            ChainStep::CGClick { .. } | ChainStep::FocusThenClearByKeyboard
        ) || policy.is_headed()
    }
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) use imp::{
    after_steps, build_step, exhaustion_disposition, exhaustion_error, record_step_outcome,
    step_allowed, step_mechanism,
};

pub(crate) mod activate_descendant;
pub(super) mod chain_context;
pub(super) mod chain_def;
pub(crate) mod chain_defs;
pub(super) mod chain_delivery;
pub(crate) mod chain_disclosure_steps;
pub(crate) mod chain_menu_steps;
pub(super) mod chain_step;
pub(crate) mod chain_step_exec;
pub(crate) mod chain_value_write;
pub(crate) mod chain_verify;
pub(crate) mod press_selection;
#[cfg(test)]
#[path = "chain_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "chain_outcome_tests.rs"]
mod outcome_tests;

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn execute_chain(
        _el: &AXElement,
        def: &ChainDef,
        _ctx: &ChainContext,
        _policy: InteractionPolicy,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "Chain execution not supported on this platform",
        )
        .with_suggestion(def.suggestion))
    }
}

pub(crate) use imp::execute_chain;
