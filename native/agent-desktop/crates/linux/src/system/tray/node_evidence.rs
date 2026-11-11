use agent_desktop_core::{
    ElementIdentifier, IdentifierEvidence, IdentifierKind, LocatorEvidence, LocatorField,
    LocatorRefEvidence, tree::state,
};

use super::TrayTarget;
use super::identity;

pub(super) const ITEM_ROLE: &str = "menubutton";
pub(super) const ENTRY_ROLE: &str = "menuitem";
pub(super) const SEPARATOR_ROLE: &str = "separator";
pub(super) fn name_field(name: &str) -> LocatorField<String> {
    if name.is_empty() {
        LocatorField::Absent
    } else {
        LocatorField::Known(name.to_owned())
    }
}

pub(super) fn identifiers(target: &TrayTarget) -> IdentifierEvidence {
    IdentifierEvidence::typed(
        [ElementIdentifier {
            kind: IdentifierKind::RuntimeId,
            value: identity::encode(target),
        }],
        Some(0),
        true,
    )
}

pub(super) fn item_states(passive: bool, mut states: Vec<String>) -> Vec<String> {
    states.retain(|token| token != state::HIDDEN);
    if passive {
        states.push(state::HIDDEN.to_owned());
    }
    states
}

pub(super) fn fresh(
    role: &str,
    name: &str,
    target: &TrayTarget,
    states: Vec<String>,
    actions: Vec<String>,
) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_owned()),
        name: name_field(name),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: identifiers(target),
        states: LocatorField::Known(states),
        ref_evidence: LocatorRefEvidence {
            bounds: LocatorField::Absent,
            window_bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(actions),
            descriptors: Default::default(),
        },
    }
}

#[cfg(test)]
#[path = "node_evidence_tests.rs"]
mod tests;
