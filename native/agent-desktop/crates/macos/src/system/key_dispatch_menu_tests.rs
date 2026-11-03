use super::*;

fn combo(modifiers: Vec<Modifier>) -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers,
    }
}

#[test]
fn menu_shortcut_requires_one_character() {
    assert_eq!(single_uppercase_character("a").as_deref(), Some("A"));
    assert!(single_uppercase_character("enter").is_none());
}

#[test]
fn menu_shortcut_matches_punctuation_by_name_and_symbol() {
    assert_eq!(single_uppercase_character("comma").as_deref(), Some(","));
    assert_eq!(single_uppercase_character(",").as_deref(), Some(","));
}

#[test]
fn menu_modifier_encoding_distinguishes_command_from_no_command() {
    assert_eq!(
        combo_to_ax_modifiers(&combo(vec![Modifier::Meta, Modifier::Alt])),
        AX_MENU_MODIFIER_OPTION
    );
    assert_eq!(
        combo_to_ax_modifiers(&combo(vec![Modifier::Alt])),
        AX_MENU_MODIFIER_OPTION | AX_MENU_MODIFIER_NO_COMMAND
    );
    assert_ne!(
        combo_to_ax_modifiers(&combo(vec![Modifier::Meta, Modifier::Alt])),
        combo_to_ax_modifiers(&combo(vec![Modifier::Alt]))
    );
}

#[test]
fn malformed_menu_modifier_values_are_not_command_shortcuts() {
    assert!(normalize_menu_modifiers(-1).is_err());
    assert!(normalize_menu_modifiers(1 << 8).is_err());
    assert_eq!(
        normalize_menu_modifiers(AX_MENU_MODIFIER_NO_COMMAND as i64).unwrap(),
        AX_MENU_MODIFIER_NO_COMMAND
    );
}
