use agent_desktop_core::{
    LocatorField, NameEvidence, NameSlotStatus, SlotStatus, resolve_description, resolve_name,
};

use super::label_outcome::LabelOutcome;
use super::placeholder::PlaceholderRead;
use super::role_numbers::APPLICATION;
use crate::tree::{Field, NodeProperties};

fn text_of(field: &Field<String>) -> Option<String> {
    field.non_blank().cloned()
}

fn slot_of<T>(field: &Field<T>) -> SlotStatus {
    NameSlotStatus::uncertain_if(field.is_failed())
}

fn label_slot(name: &Field<String>, label: &LabelOutcome) -> SlotStatus {
    if name.non_blank().is_some() {
        return SlotStatus::Suppressed;
    }
    if name.is_failed() {
        return SlotStatus::Uncertain;
    }
    match label {
        LabelOutcome::Text(_) => SlotStatus::Certain,
        LabelOutcome::Unlabelled => SlotStatus::Suppressed,
        LabelOutcome::Failed => SlotStatus::Uncertain,
    }
}

fn description_of(
    properties: &NodeProperties,
    role: &Field<u32>,
    placeholder: &PlaceholderRead,
) -> (Option<String>, SlotStatus) {
    match role {
        Field::Present(number) if *number == APPLICATION => (None, SlotStatus::Suppressed),
        Field::Present(_) => match placeholder {
            PlaceholderRead::Description(_) => (None, SlotStatus::Suppressed),
            _ => (
                text_of(&properties.description),
                slot_of(&properties.description),
            ),
        },
        Field::Absent | Field::Failed(_) => (None, SlotStatus::Uncertain),
    }
}

fn placeholder_slot(placeholder: &PlaceholderRead) -> SlotStatus {
    match placeholder {
        PlaceholderRead::Uncertain => SlotStatus::Uncertain,
        _ => SlotStatus::Certain,
    }
}

/// The name and the description of a node, resolved by core's one precedence.
/// `Name` is the toolkit's own computed name, so a `LabelledBy` target is
/// admitted only when `Name` is blank; the other slots do not apply to AT-SPI.
pub(crate) fn name_fields(
    properties: &NodeProperties,
    role: &Field<u32>,
    placeholder: &PlaceholderRead,
    label: &LabelOutcome,
) -> (LocatorField<String>, LocatorField<String>) {
    let (description, description_status) = description_of(properties, role, placeholder);
    let evidence = NameEvidence {
        native_title: text_of(&properties.name),
        labelled_by_text: match label {
            LabelOutcome::Text(text) => Some(text.clone()),
            LabelOutcome::Unlabelled | LabelOutcome::Failed => None,
        },
        description,
        placeholder: placeholder.text().map(str::to_owned),
        explicit_label: None,
        static_value: None,
        child_label: None,
    };
    let status = NameSlotStatus {
        native_title: slot_of(&properties.name),
        labelled_by_text: label_slot(&properties.name, label),
        description: description_status,
        placeholder: placeholder_slot(placeholder),
        explicit_label: SlotStatus::Suppressed,
        static_value: SlotStatus::Suppressed,
        child_label: SlotStatus::Suppressed,
    };
    (
        resolve_name(&evidence, &status),
        resolve_description(&evidence, &status),
    )
}

#[cfg(test)]
#[path = "name_evidence_tests.rs"]
mod tests;
