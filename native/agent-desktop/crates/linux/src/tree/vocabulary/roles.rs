use agent_desktop_core::{LocatorField, Role};

use super::gtk_switch::is_gtk_switch;
use super::role_numbers::{CHECK_BOX, LANDMARK, LIST, PUSH_BUTTON, TERMINAL, TEXT};
use super::role_table::base_role;
use super::state_bits::{EDITABLE, FOCUSABLE, HAS_POPUP, READ_ONLY, StateBits};
use crate::tree::properties::attributes::{AttributeRead, first_xml_role};
use crate::tree::{Field, NodeTraits};

const SELECTION_INTERFACE: &str = "org.a11y.atspi.Selection";
const LANDMARK_TOKENS: [&str; 7] = [
    "banner",
    "main",
    "navigation",
    "complementary",
    "contentinfo",
    "search",
    "form",
];

fn has_state(states: &Field<Vec<u32>>, bit: u32) -> bool {
    states
        .present()
        .is_some_and(|words| StateBits::new(words).has(bit))
}

fn text_role(states: &Field<Vec<u32>>) -> Role {
    if has_state(states, EDITABLE) {
        Role::TextField
    } else {
        Role::Document
    }
}

fn terminal_role(states: &Field<Vec<u32>>) -> Role {
    if has_state(states, FOCUSABLE) && !has_state(states, READ_ONLY) {
        Role::TextField
    } else {
        Role::Document
    }
}

fn push_button_role(states: &Field<Vec<u32>>) -> Role {
    if has_state(states, HAS_POPUP) {
        Role::MenuButton
    } else {
        Role::Button
    }
}

fn list_role(interfaces: &Field<Vec<String>>) -> Role {
    let selectable = interfaces
        .present()
        .is_some_and(|names| names.iter().any(|name| name == SELECTION_INTERFACE));
    if selectable {
        Role::ListBox
    } else {
        Role::List
    }
}

fn landmark_role(attributes: &AttributeRead) -> Role {
    match first_xml_role(attributes) {
        Some(token) if LANDMARK_TOKENS.contains(&token.as_str()) => Role::from_token(&token),
        _ => Role::Region,
    }
}

/// The canonical role for an AT-SPI role number. A refinement that depends
/// on another read falls back to the unrefined role when that read failed.
pub(crate) fn role_of(
    number: u32,
    states: &Field<Vec<u32>>,
    interfaces: &Field<Vec<String>>,
    attributes: &AttributeRead,
) -> Role {
    match number {
        TEXT => text_role(states),
        TERMINAL => terminal_role(states),
        PUSH_BUTTON => push_button_role(states),
        LIST => list_role(interfaces),
        LANDMARK => landmark_role(attributes),
        other => base_role(other),
    }
}

/// Whether a node with this AT-SPI role number can read as the role token
/// under some states, interfaces and attributes. A node that cannot is
/// refuted by its number alone; the refinements are the only reads that
/// move a number to a different role.
pub(crate) fn may_resolve_to(number: u32, token: &str) -> bool {
    let reachable: &[Role] = match number {
        TEXT | TERMINAL => &[Role::TextField, Role::Document],
        PUSH_BUTTON => &[Role::MenuButton, Role::Button],
        LIST => &[Role::ListBox, Role::List],
        CHECK_BOX => &[Role::Checkbox, Role::Switch],
        LANDMARK => return true,
        other => return base_role(other).as_str() == token,
    };
    reachable.iter().any(|role| role.as_str() == token)
}

/// The role token of a node, or unknown when the role read failed. That is
/// not the canonical `unknown` role: it says nothing was read. A GTK switch
/// is a check box by number but a `switch` by role, as on macOS and Windows.
pub(crate) fn resolve_role(
    traits: &NodeTraits,
    attributes: &AttributeRead,
) -> LocatorField<String> {
    let Some(number) = traits.role.present() else {
        return LocatorField::Unknown;
    };
    let role = if is_gtk_switch(&traits.role, &traits.role_name, attributes) {
        Role::Switch
    } else {
        role_of(*number, &traits.states, &traits.interfaces, attributes)
    };
    LocatorField::Known(role.as_str().to_owned())
}

#[cfg(test)]
#[path = "roles_tests.rs"]
mod tests;
