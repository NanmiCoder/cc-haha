pub(super) mod descriptor;
pub(super) mod gtk_switch;
pub(super) mod identity;
pub(super) mod label_outcome;
pub(super) mod label_read;
pub(super) mod name_evidence;
pub(super) mod placeholder;
pub(crate) mod role_numbers;
pub(super) mod role_table;
pub(super) mod roles;
pub(crate) mod state_bits;
pub(super) mod states;

use agent_desktop_core::{IdentifierEvidence, LocatorField, NodeDescriptor};

use super::RawNode;
use super::vocabulary::descriptor::descriptors;
use super::vocabulary::identity::identifier_evidence;
use super::vocabulary::label_outcome::LabelOutcome;
use super::vocabulary::name_evidence::name_fields;
use super::vocabulary::placeholder::read_placeholder;
use super::vocabulary::roles::resolve_role;
use super::vocabulary::states::resolve_states;

/// What a node means, in core's own types.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedVocabulary {
    pub(crate) role: LocatorField<String>,
    pub(crate) states: LocatorField<Vec<String>>,
    pub(crate) name: LocatorField<String>,
    pub(crate) description: LocatorField<String>,
    pub(crate) identifiers: IdentifierEvidence,
    pub(crate) descriptor: NodeDescriptor,
}

/// Resolves the vocabulary of one raw node. `in_web_document` is true when
/// the node sits below a web document, which the walk knows from its path.
pub(crate) fn resolve_vocabulary(
    node: &RawNode,
    label: &LabelOutcome,
    in_web_document: bool,
) -> ResolvedVocabulary {
    let traits = &node.traits;
    let placeholder = read_placeholder(&node.properties, &traits.role, &node.attributes);
    let (name, description) = name_fields(&node.properties, &traits.role, &placeholder, label);
    ResolvedVocabulary {
        role: resolve_role(traits, &node.attributes),
        states: resolve_states(&traits.role, &traits.states),
        name,
        description,
        identifiers: identifier_evidence(
            &node.properties.accessible_id,
            &node.attributes,
            in_web_document,
        ),
        descriptor: descriptors(
            &traits.role,
            &traits.role_name,
            &placeholder,
            &node.attributes,
            in_web_document,
        ),
    }
}
