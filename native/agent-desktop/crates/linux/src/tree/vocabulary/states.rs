use agent_desktop_core::{LocatorField, tree::state};

use super::role_numbers::{
    CHECK_BOX, CHECK_MENU_ITEM, PASSWORD_TEXT, PUSH_BUTTON, PUSH_BUTTON_MENU, RADIO_BUTTON,
    RADIO_MENU_ITEM, TOGGLE_BUTTON,
};
use super::state_bits::{
    BUSY, CHECKED, EXPANDED, FOCUSED, HAS_POPUP, INDETERMINATE, INVALID_ENTRY, MODAL,
    MULTISELECTABLE, PRESSED, READ_ONLY, REQUIRED, SELECTED, StateBits,
};
use crate::tree::Field;

const UNGATED: [(u32, &str); 9] = [
    (FOCUSED, state::FOCUSED),
    (SELECTED, state::SELECTED),
    (EXPANDED, state::EXPANDED),
    (REQUIRED, state::REQUIRED),
    (READ_ONLY, state::READONLY),
    (MODAL, state::MODAL),
    (BUSY, state::BUSY),
    (MULTISELECTABLE, state::MULTISELECTABLE),
    (HAS_POPUP, state::HASPOPUP),
];

fn can_be_checked(role: u32) -> bool {
    matches!(
        role,
        CHECK_BOX | RADIO_BUTTON | CHECK_MENU_ITEM | RADIO_MENU_ITEM | TOGGLE_BUTTON
    )
}

fn can_be_pressed(role: u32) -> bool {
    matches!(role, PUSH_BUTTON | PUSH_BUTTON_MENU)
}

/// Resolves the canonical state tokens from the state bit words and the role
/// number. Every token is a positive claim from a bit that is set; the one
/// negative, `disabled`, needs a successful state read with neither `ENABLED`
/// nor `SENSITIVE` set, because GTK4 never sets `ENABLED`, and never for a
/// read-only node, because Chromium leaves both bits unset on a read-only
/// input that is enabled. The result is
/// unknown when the state read or the role read failed, since the role
/// decides `secure` and which toggle bits count.
pub(crate) fn resolve_states(
    role: &Field<u32>,
    words: &Field<Vec<u32>>,
) -> LocatorField<Vec<String>> {
    let (Some(role), Some(words)) = (role.present(), words.present()) else {
        return LocatorField::Unknown;
    };
    let bits = StateBits::new(words);
    let mut tokens = Vec::new();
    if bits.is_disabled() {
        tokens.push(state::DISABLED);
    }
    if *role == PASSWORD_TEXT {
        tokens.push(state::SECURE);
    }
    for (bit, token) in UNGATED {
        if bits.has(bit) {
            tokens.push(token);
        }
    }
    if bits.has(INVALID_ENTRY) {
        tokens.push(state::INVALID);
    }
    if can_be_checked(*role) {
        let on = bits.has(CHECKED) || (*role == TOGGLE_BUTTON && bits.has(PRESSED));
        if on {
            tokens.push(state::CHECKED);
        }
        if bits.has(INDETERMINATE) {
            tokens.push(state::INDETERMINATE);
        }
    }
    if can_be_pressed(*role) && bits.has(PRESSED) {
        tokens.push(state::PRESSED);
    }
    LocatorField::Known(tokens.into_iter().map(str::to_owned).collect())
}

#[cfg(test)]
#[path = "states_tests.rs"]
mod tests;
