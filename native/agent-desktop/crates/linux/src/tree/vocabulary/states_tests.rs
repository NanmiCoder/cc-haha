use agent_desktop_core::{LocatorField, tree::state};

use super::resolve_states;
use crate::tree::Field;
use crate::tree::live::test_support::words;
use crate::tree::vocabulary::role_numbers::{
    CHECK_BOX, CHECK_MENU_ITEM, PASSWORD_TEXT, PUSH_BUTTON, PUSH_BUTTON_MENU, RADIO_BUTTON,
    RADIO_MENU_ITEM, TOGGLE_BUTTON,
};
use crate::tree::vocabulary::state_bits::{
    CHECKED, ENABLED, FOCUSED, INDETERMINATE, INVALID_ENTRY, PRESSED, READ_ONLY, REQUIRED,
    SENSITIVE, SHOWING, StateBits,
};

const GROUP: u32 = 39;

fn tokens(role: u32, bits: &[u32]) -> Vec<String> {
    match resolve_states(&Field::Present(role), &Field::Present(words(bits))) {
        LocatorField::Known(tokens) => tokens,
        other => panic!("expected a known state list, got {other:?}"),
    }
}

fn has(role: u32, bits: &[u32], token: &str) -> bool {
    tokens(role, bits)
        .iter()
        .any(|candidate| candidate == token)
}

#[test]
fn state_mapping_boundaries() {
    assert!(has(GROUP, &[ENABLED, REQUIRED], state::REQUIRED));
    let first_word_only = vec![1u32 << (REQUIRED % 32), 0];
    let LocatorField::Known(found) =
        resolve_states(&Field::Present(GROUP), &Field::Present(first_word_only))
    else {
        panic!("expected a known state list");
    };
    assert!(!found.iter().any(|token| token == state::REQUIRED));
    let bits = StateBits::new(&[1 << 14, 1 << (REQUIRED % 32)]);
    assert!(bits.has(14));
    assert!(!bits.has(13));
    assert!(bits.has(REQUIRED));

    assert!(!has(PUSH_BUTTON, &[SENSITIVE, SHOWING], state::DISABLED));
    assert!(!has(PUSH_BUTTON, &[ENABLED], state::DISABLED));
    assert!(has(PUSH_BUTTON, &[SHOWING], state::DISABLED));
    assert!(!has(GROUP, &[READ_ONLY], state::DISABLED));
    assert!(has(GROUP, &[READ_ONLY], state::READONLY));
    assert!(has(GROUP, &[0], state::DISABLED));

    assert_eq!(
        resolve_states(&Field::Present(GROUP), &Field::Failed("gone".to_owned())),
        LocatorField::Unknown
    );
    assert_eq!(
        resolve_states(
            &Field::Failed("gone".to_owned()),
            &Field::Present(words(&[ENABLED]))
        ),
        LocatorField::Unknown
    );
    assert_eq!(
        resolve_states(&Field::Present(GROUP), &Field::Present(words(&[ENABLED]))),
        LocatorField::Known(Vec::new())
    );

    assert!(has(PASSWORD_TEXT, &[SENSITIVE], state::SECURE));
    assert!(!has(GROUP, &[SENSITIVE], state::SECURE));
    assert!(has(GROUP, &[SENSITIVE, FOCUSED], state::FOCUSED));
    assert!(has(GROUP, &[SENSITIVE, INVALID_ENTRY], state::INVALID));
    assert!(tokens(GROUP, &[SENSITIVE, 0]).is_empty());
    assert!(has(CHECK_BOX, &[SENSITIVE, CHECKED], state::CHECKED));
    assert!(!has(PUSH_BUTTON, &[SENSITIVE, CHECKED], state::CHECKED));
    assert!(!has(CHECK_BOX, &[SENSITIVE, PRESSED], state::CHECKED));
    for role in [
        RADIO_BUTTON,
        CHECK_MENU_ITEM,
        RADIO_MENU_ITEM,
        TOGGLE_BUTTON,
    ] {
        assert!(
            has(role, &[SENSITIVE, CHECKED], state::CHECKED),
            "role {role}"
        );
    }
    assert!(has(TOGGLE_BUTTON, &[SENSITIVE, PRESSED], state::CHECKED));
    assert!(!has(TOGGLE_BUTTON, &[SENSITIVE, PRESSED], state::PRESSED));
    for role in [PUSH_BUTTON, PUSH_BUTTON_MENU] {
        assert!(
            has(role, &[SENSITIVE, PRESSED], state::PRESSED),
            "role {role}"
        );
        assert!(
            !has(role, &[SENSITIVE, PRESSED], state::CHECKED),
            "role {role}"
        );
    }
    assert!(has(
        CHECK_BOX,
        &[SENSITIVE, INDETERMINATE],
        state::INDETERMINATE
    ));
    assert!(!has(
        GROUP,
        &[SENSITIVE, INDETERMINATE],
        state::INDETERMINATE
    ));
}
