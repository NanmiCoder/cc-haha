use super::is_blocked;
use agent_desktop_core::{KeyCombo, Modifier};

fn combo(modifiers: Vec<Modifier>, key: &str) -> KeyCombo {
    KeyCombo {
        key: key.to_owned(),
        modifiers,
    }
}

#[test]
fn dangerous_shortcuts_are_blocked() {
    assert!(is_blocked(&combo(vec![Modifier::Meta], "q")));
    assert!(is_blocked(&combo(
        vec![Modifier::Meta, Modifier::Shift],
        "q"
    )));
    assert!(is_blocked(&combo(
        vec![Modifier::Meta, Modifier::Alt],
        "esc"
    )));
    assert!(is_blocked(&combo(
        vec![Modifier::Ctrl, Modifier::Meta],
        "q"
    )));
    assert!(is_blocked(&combo(
        vec![Modifier::Meta, Modifier::Shift],
        "delete"
    )));
}

#[test]
fn modifier_order_does_not_matter() {
    assert!(
        is_blocked(&combo(vec![Modifier::Meta, Modifier::Ctrl], "q")),
        "cmd+ctrl+q must match the blocked ctrl+cmd+q regardless of order"
    );
}

#[test]
fn key_aliases_are_blocked() {
    assert!(
        is_blocked(&combo(vec![Modifier::Meta, Modifier::Alt], "escape")),
        "escape is the same physical key as esc"
    );
    assert!(
        is_blocked(&combo(vec![Modifier::Meta, Modifier::Shift], "backspace")),
        "backspace is the same physical key as delete"
    );
}

#[test]
fn benign_combos_are_not_blocked() {
    assert!(!is_blocked(&combo(vec![Modifier::Meta], "c")));
    assert!(!is_blocked(&combo(vec![Modifier::Meta], "v")));
    assert!(!is_blocked(&combo(vec![Modifier::Meta], "w")));
    assert!(!is_blocked(&combo(
        vec![Modifier::Meta, Modifier::Shift],
        "r"
    )));
    assert!(!is_blocked(&combo(vec![Modifier::Ctrl], "s")));
    assert!(!is_blocked(&combo(vec![], "return")));
}

/// Adding a modifier to a dangerous shortcut generally yields another
/// dangerous shortcut: `cmd+shift+q` force-quits like `cmd+q`, and
/// `cmd+shift+ctrl+q` is even more dangerous.
#[test]
fn a_modifier_superset_of_a_blocked_combo_does_not_evade_the_block() {
    assert!(
        is_blocked(&combo(vec![Modifier::Meta, Modifier::Shift], "q")),
        "cmd+shift+q force-quits"
    );
    assert!(
        is_blocked(&combo(
            vec![Modifier::Meta, Modifier::Shift, Modifier::Ctrl],
            "q"
        )),
        "cmd+shift+ctrl+q is a superset of cmd+q"
    );
}

/// The superset rule keys on the key as well as the modifiers, so an
/// unrelated shortcut that merely shares a modifier stays allowed.
#[test]
fn a_superset_of_the_modifiers_alone_is_not_blocked() {
    assert!(
        !is_blocked(&combo(vec![Modifier::Meta, Modifier::Shift], "w")),
        "cmd+shift+w is not a blocked shortcut"
    );
    assert!(
        !is_blocked(&combo(vec![Modifier::Meta], "w")),
        "cmd+w is not a blocked shortcut"
    );
}
