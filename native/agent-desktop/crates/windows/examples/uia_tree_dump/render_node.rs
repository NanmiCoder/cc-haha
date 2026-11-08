//! One node's JSON, built from evidence that has already been read.
//!
//! Split from `render.rs` so the renderer sits beside the test that proves it
//! withholds target-authored text, and so neither file lives at the size cap.

use agent_desktop_windows::tree::name_evidence::LabelOutcome;
use agent_desktop_windows::tree::properties::element_properties::ResolvedVocabulary;
use agent_desktop_windows::tree::properties::property_ids::TreeProperty;
use agent_desktop_windows::tree::properties::{ElementProperties, PropertyOutcome};
use serde_json::{Value, json};

use super::render_slots::{field_list, field_presence, role_of, slot, text_presence};

/// Where one node sits in the dump being built.
///
/// `depth` is the traversal's, not the renderer's: the census recursion needs
/// it to enforce the depth bound, and the rendered node does not carry it.
#[derive(Clone, Copy)]
pub(crate) struct Position {
    pub(crate) parent: Option<usize>,
    pub(crate) index: usize,
    pub(crate) depth: u8,
}

/// Everything one rendered node needs, already read.
///
/// Grouped so the renderer takes a single parameter, and so a test can build
/// this shape by hand - no `UIAElement`, no COM - and drive the exact function
/// that decides what reaches a committed capture verbatim.
pub(crate) struct NodeFields {
    pub(crate) position: Position,
    pub(crate) properties: ElementProperties,
    pub(crate) vocabulary: ResolvedVocabulary,
    pub(crate) label: LabelOutcome,
    pub(crate) provider_description: PropertyOutcome,
    pub(crate) failed_reads: usize,
}

/// Renders one node's JSON from already-resolved evidence.
///
/// COM-free by construction, which is what makes the marker test possible:
/// every free-text property (name, description, automation id, help text, full
/// description, legacy default action, subrole, role description, placeholder)
/// goes through a withholding renderer here, and `render_node_tests.rs` fails
/// if any one of them is switched back to a verbatim `slot()`. `class_name` and
/// `provider_description` are emitted verbatim because they identify the
/// control class and UIA provider rather than carry user content.
pub(crate) fn render_node(fields: &NodeFields) -> Value {
    json!({
        "parent_index": fields.position.parent,
        "child_index": fields.position.index,
        "control_type": slot(&fields.properties.get(TreeProperty::ControlType)),
        "role": role_of(&fields.vocabulary.role),
        "available_actions": field_list(&fields.vocabulary.available_actions),
        "states": field_list(&fields.vocabulary.states),
        "name": field_presence(&fields.vocabulary.name),
        "description": field_presence(&fields.vocabulary.description),
        "labelled": !matches!(fields.label, LabelOutcome::Unlabelled),
        "class_name": slot(&fields.properties.get(TreeProperty::ClassName)),
        "automation_id": text_presence(&fields.properties.get(TreeProperty::AutomationId)),
        "help_text": text_presence(&fields.properties.get(TreeProperty::HelpText)),
        "full_description": text_presence(&fields.properties.get(TreeProperty::FullDescription)),
        "legacy_default_action": text_presence(&fields.properties.get(TreeProperty::LegacyDefaultAction)),
        "bounds": slot(&fields.properties.get(TreeProperty::BoundingRectangle)),
        "is_password": slot(&fields.properties.get(TreeProperty::IsPassword)),
        "is_offscreen": slot(&fields.properties.get(TreeProperty::IsOffscreen)),
        "is_control_element": slot(&fields.properties.get(TreeProperty::IsControlElement)),
        "is_content_element": slot(&fields.properties.get(TreeProperty::IsContentElement)),
        "provider_description": slot(&fields.provider_description),
        "subrole": text_presence(&fields.properties.get(TreeProperty::AriaRole)),
        "role_description": text_presence(&fields.properties.get(TreeProperty::LocalizedControlType)),
        "placeholder": text_presence(&fields.properties.get(TreeProperty::HelpText)),
        "failed_reads": fields.failed_reads,
    })
}

#[cfg(test)]
#[path = "render_node_tests.rs"]
mod tests;
