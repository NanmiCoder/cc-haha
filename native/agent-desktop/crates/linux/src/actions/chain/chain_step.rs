use agent_desktop_core::{ActionStep, StepMechanism};

use super::chain_observed::Observed;

pub(crate) fn semantic_step(label: &'static str, verified: Option<bool>) -> ActionStep {
    let step = ActionStep::succeeded(label).with_mechanism(StepMechanism::SemanticApi);
    match verified {
        Some(verified) => step.with_verified(verified),
        None => step,
    }
}

pub(crate) fn skipped_step(label: &'static str) -> ActionStep {
    ActionStep::skipped(label).with_mechanism(StepMechanism::SemanticApi)
}

pub(crate) fn satisfied_step(label: &'static str) -> ActionStep {
    skipped_step(label).with_verified(true)
}

pub(crate) fn verified_of(observed: Observed) -> Option<bool> {
    match observed {
        Observed::Matched => Some(true),
        Observed::Unchanged => Some(false),
        Observed::Unread => None,
    }
}
