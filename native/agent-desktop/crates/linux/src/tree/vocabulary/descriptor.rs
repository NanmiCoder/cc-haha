use agent_desktop_core::NodeDescriptor;

use super::gtk_switch::{GTK_SWITCH_ROLE_NAME, is_gtk_switch};
use super::placeholder::PlaceholderRead;
use crate::tree::Field;
use crate::tree::properties::attributes::{AttributeRead, first_xml_role, non_blank};

fn subrole(
    role: &Field<u32>,
    role_name: &Field<String>,
    attributes: &AttributeRead,
) -> Option<String> {
    first_xml_role(attributes).or_else(|| {
        is_gtk_switch(role, role_name, attributes).then(|| GTK_SWITCH_ROLE_NAME.to_owned())
    })
}

fn classes(attributes: &AttributeRead, in_web_document: bool) -> Vec<String> {
    if !in_web_document {
        return Vec::new();
    }
    non_blank(attributes, "class")
        .map(|value| value.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

/// The presentation descriptors of a node. Every field is a positive claim:
/// a failed read contributes nothing. `GetRoleName` is a toolkit-local string,
/// so the one GTK pair it is matched on is gated on the `toolkit` attribute.
pub(crate) fn descriptors(
    role: &Field<u32>,
    role_name: &Field<String>,
    placeholder: &PlaceholderRead,
    attributes: &AttributeRead,
    in_web_document: bool,
) -> NodeDescriptor {
    NodeDescriptor {
        subrole: subrole(role, role_name, attributes),
        role_description: non_blank(attributes, "roledescription").map(str::to_owned),
        placeholder: placeholder.text().map(str::to_owned),
        dom_classes: classes(attributes, in_web_document),
    }
}

#[cfg(test)]
#[path = "descriptor_tests.rs"]
mod tests;
