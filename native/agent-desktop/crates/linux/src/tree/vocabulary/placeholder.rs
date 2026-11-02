use super::role_numbers::{ENTRY, PASSWORD_TEXT, TEXT};
use crate::tree::properties::attributes::{AttributeRead, has_key, non_blank};
use crate::tree::{Field, NodeProperties};

const WEB_KEYS: [&str; 3] = ["tag", "xml-roles", "toolkit"];

/// Where a node's placeholder comes from, or that it has none or could not
/// be told. One function decides it for both the name evidence and the
/// descriptor, so the two cannot diverge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlaceholderRead {
    Attribute(String),
    Description(String),
    Absent,
    Uncertain,
}

impl PlaceholderRead {
    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Self::Attribute(text) | Self::Description(text) => Some(text),
            Self::Absent | Self::Uncertain => None,
        }
    }
}

fn is_text_input(role: u32) -> bool {
    matches!(role, PASSWORD_TEXT | TEXT | ENTRY)
}

fn carries_a_toolkit_marker(attributes: &AttributeRead) -> bool {
    WEB_KEYS.iter().any(|key| has_key(attributes, key))
}

fn description_as_placeholder(properties: &NodeProperties, role: &Field<u32>) -> PlaceholderRead {
    let text_input = match role {
        Field::Present(number) => is_text_input(*number),
        Field::Absent | Field::Failed(_) => return PlaceholderRead::Uncertain,
    };
    if !text_input {
        return PlaceholderRead::Absent;
    }
    if let Some(text) = properties.description.non_blank() {
        return PlaceholderRead::Description(text.clone());
    }
    if properties.description.is_failed() {
        PlaceholderRead::Uncertain
    } else {
        PlaceholderRead::Absent
    }
}

/// Chromium keeps the placeholder in the `placeholder` attribute, Gecko in
/// `placeholder-text`, and Qt in `Description` of a text input whose
/// attributes show neither a web nor a GTK origin. GTK `Description` is a
/// tooltip and stays a description. A failed attribute read leaves the
/// placeholder uncertain and reclassifies nothing.
pub(crate) fn read_placeholder(
    properties: &NodeProperties,
    role: &Field<u32>,
    attributes: &AttributeRead,
) -> PlaceholderRead {
    if attributes.is_failed() {
        return PlaceholderRead::Uncertain;
    }
    for key in ["placeholder", "placeholder-text"] {
        if let Some(text) = non_blank(attributes, key) {
            return PlaceholderRead::Attribute(text.to_owned());
        }
    }
    if carries_a_toolkit_marker(attributes) {
        return PlaceholderRead::Absent;
    }
    description_as_placeholder(properties, role)
}
