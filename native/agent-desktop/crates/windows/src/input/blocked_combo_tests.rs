use super::*;

fn combo(key: &str, modifiers: Vec<Modifier>) -> KeyCombo {
    KeyCombo {
        key: key.into(),
        modifiers,
    }
}

#[test]
fn every_windows_dangerous_combo_is_blocked() {
    assert!(is_blocked(&combo("f4", vec![Modifier::Alt])), "alt+f4");
    assert!(is_blocked(&combo("l", vec![Modifier::Meta])), "win+l");
    assert!(is_blocked(&combo("d", vec![Modifier::Meta])), "win+d");
    assert!(is_blocked(&combo("tab", vec![Modifier::Alt])), "alt+tab");
}

#[test]
fn a_non_dangerous_combo_is_never_blocked() {
    assert!(!is_blocked(&combo("c", vec![Modifier::Ctrl])));
    assert!(!is_blocked(&combo("a", vec![])));
    assert!(!is_blocked(&combo(
        "s",
        vec![Modifier::Ctrl, Modifier::Shift]
    )));
}

/// The Secure Attention Sequence is not presented as guarded: `SendInput`
/// cannot synthesize it, so claiming to block it would be dishonest.
#[test]
fn ctrl_alt_delete_is_not_claimed_as_blocked() {
    assert!(!is_blocked(&combo(
        "delete",
        vec![Modifier::Ctrl, Modifier::Alt]
    )));
}

#[test]
fn modifier_reordering_does_not_evade_the_block() {
    let orderings = [
        (
            combo("esc", vec![Modifier::Ctrl, Modifier::Shift]),
            combo("esc", vec![Modifier::Shift, Modifier::Ctrl]),
        ),
        (
            combo("tab", vec![Modifier::Alt, Modifier::Shift]),
            combo("tab", vec![Modifier::Shift, Modifier::Alt]),
        ),
    ];
    for (forward, reversed) in &orderings {
        assert!(is_blocked(forward), "{}", combo_to_string(forward));
        assert!(is_blocked(reversed), "{}", combo_to_string(reversed));
        assert_eq!(
            canonical_parts(&combo_to_string(forward)),
            canonical_parts(&combo_to_string(reversed)),
            "modifier position must not change the canonical form"
        );
    }
}

#[test]
fn key_name_aliases_do_not_evade_the_block() {
    assert_eq!(canonical_parts("alt+f4"), canonical_parts("ALT+F4"));
    assert_eq!(canonical_parts("win+l"), canonical_parts("meta+l"));
    assert_eq!(canonical_parts("win+d"), canonical_parts("cmd+d"));
}

#[test]
fn canonical_key_folds_documented_aliases() {
    assert_eq!(canonical_key("escape"), "esc");
    assert_eq!(canonical_key("esc"), "esc");
    assert_eq!(canonical_key("backspace"), "delete");
    assert_eq!(canonical_key("delete"), "delete");
    assert_eq!(canonical_key("enter"), "return");
    assert_eq!(canonical_key("return"), "return");
}

#[test]
fn combo_to_string_places_modifiers_before_the_key() {
    let text = combo_to_string(&combo("f4", vec![Modifier::Alt]));
    assert_eq!(text, "alt+f4");
}

/// Adding a modifier to a dangerous shortcut generally yields another
/// dangerous shortcut: `alt+shift+tab` is the reverse task switcher and
/// takes the foreground exactly as `alt+tab` does.
#[test]
fn a_modifier_superset_of_a_blocked_combo_does_not_evade_the_block() {
    assert!(
        is_blocked(&combo("tab", vec![Modifier::Alt, Modifier::Shift])),
        "alt+shift+tab is the reverse task switcher"
    );
    assert!(
        is_blocked(&combo("tab", vec![Modifier::Alt, Modifier::Ctrl])),
        "ctrl+alt+tab is the persistent task switcher"
    );
    assert!(
        is_blocked(&combo("f4", vec![Modifier::Shift, Modifier::Alt])),
        "a superset of alt+f4 still closes the window"
    );
}

/// The superset rule keys on the key as well as the modifiers, so an
/// unrelated shortcut that merely shares a modifier stays allowed.
#[test]
fn a_superset_of_the_modifiers_alone_is_not_blocked() {
    assert!(
        !is_blocked(&combo("f5", vec![Modifier::Alt, Modifier::Shift])),
        "alt+shift+f5 shares alt+tab's modifiers but not its key"
    );
    assert!(
        !is_blocked(&combo("tab", vec![Modifier::Ctrl])),
        "ctrl+tab cycles within an application and is not a blocked shortcut"
    );
}

/// Each shell-surface shortcut raises a surface over the run exactly as
/// `alt+f4`/`win+l`/`win+d`/`alt+tab` do, so each is blocked the same way.
#[test]
fn each_shell_surface_shortcut_is_blocked() {
    assert!(
        is_blocked(&combo("r", vec![Modifier::Meta])),
        "win+r opens Run"
    );
    assert!(
        is_blocked(&combo("x", vec![Modifier::Meta])),
        "win+x opens the Quick Link menu"
    );
    assert!(
        is_blocked(&combo("e", vec![Modifier::Meta])),
        "win+e opens File Explorer"
    );
    assert!(
        is_blocked(&combo("esc", vec![Modifier::Ctrl, Modifier::Shift])),
        "ctrl+shift+esc opens Task Manager"
    );
}

#[test]
fn a_modifier_superset_of_each_shell_surface_shortcut_is_still_blocked() {
    assert!(
        is_blocked(&combo("r", vec![Modifier::Meta, Modifier::Shift])),
        "win+shift+r is still Run"
    );
    assert!(
        is_blocked(&combo("x", vec![Modifier::Meta, Modifier::Ctrl])),
        "ctrl+win+x is still the Quick Link menu"
    );
    assert!(
        is_blocked(&combo("e", vec![Modifier::Meta, Modifier::Alt])),
        "alt+win+e is still File Explorer"
    );
    assert!(
        is_blocked(&combo(
            "esc",
            vec![Modifier::Ctrl, Modifier::Shift, Modifier::Alt]
        )),
        "alt+ctrl+shift+esc is still Task Manager"
    );
}

#[test]
fn a_near_miss_of_a_shell_surface_shortcut_is_not_blocked() {
    assert!(
        !is_blocked(&combo("r", vec![Modifier::Ctrl])),
        "ctrl+r is not win+r"
    );
    assert!(
        !is_blocked(&combo("esc", vec![Modifier::Ctrl])),
        "ctrl+esc is missing the shift that ctrl+shift+esc needs"
    );
    assert!(
        !is_blocked(&combo("esc", vec![Modifier::Shift])),
        "shift+esc is missing the ctrl that ctrl+shift+esc needs"
    );
}

/// `canonical_key` folds `escape` and `esc` to the same spelling before the
/// blocked-key comparison, so either spelling must reach Task Manager's
/// guard.
#[test]
fn both_escape_and_esc_spellings_reach_the_task_manager_guard() {
    assert!(is_blocked(&combo(
        "escape",
        vec![Modifier::Ctrl, Modifier::Shift]
    )));
    assert!(is_blocked(&combo(
        "esc",
        vec![Modifier::Ctrl, Modifier::Shift]
    )));
}
