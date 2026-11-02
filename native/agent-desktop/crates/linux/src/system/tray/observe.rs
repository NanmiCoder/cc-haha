use agent_desktop_core::{
    AdapterError, Deadline, LiveElement, LocatorEvidence, LocatorField, LocatorRefEvidence,
    LocatorStats, ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
};

use super::{TrayTarget, live};

pub(super) fn evidence_of(live: &LiveElement) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(live.state.role.clone()),
        name: live.identity.name.clone(),
        description: live.identity.description.clone(),
        value: LocatorField::Absent,
        identifiers: live.identity.identifiers.clone(),
        states: LocatorField::Known(live.state.states.clone()),
        ref_evidence: LocatorRefEvidence {
            bounds: live
                .bounds
                .map_or(LocatorField::Absent, LocatorField::Known),
            window_bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(live.available_actions.clone()),
            descriptors: Default::default(),
        },
    }
}

/// The tree rooted at one tray item or menu entry: that node alone, read live
/// and carrying the identity that names it. A locator that selected the node
/// is hydrated from it.
pub(crate) fn observe(
    target: &TrayTarget,
    root: ObservationRoot<'_>,
    deadline: Deadline,
) -> Result<ObservedTree, AdapterError> {
    let element = live::element(target, deadline)?;
    let subtree = ObservedSubtree::new(evidence_of(&element), Vec::new(), true, None);
    ObservedTree::from_roots(
        vec![subtree],
        ObservationSource::from_root(&root, root.surface()),
        LocatorStats::default(),
        true,
    )
}

#[cfg(test)]
#[path = "observe_tests.rs"]
mod tests;
