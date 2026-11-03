use super::*;
use agent_desktop_core::Modifier;

#[test]
fn process_preflight_failure_reports_no_key_delivery() {
    let error = press_for_app_impl(
        ProcessIdentity::new(u32::MAX, "invalid"),
        &combo(Vec::new()),
        agent_desktop_core::InteractionPolicy::default(),
        Deadline::standard().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

fn combo(modifiers: Vec<Modifier>) -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers,
    }
}

fn key(name: &str, modifiers: Vec<Modifier>) -> KeyCombo {
    KeyCombo {
        key: name.into(),
        modifiers,
    }
}

#[test]
fn printable_keys_are_never_translated_into_ax_actions() {
    for name in ["space", "a", "1", "tab", "delete"] {
        assert_eq!(simple_key_action(&key(name, Vec::new())), None, "{name}");
    }
}

#[test]
fn return_and_escape_map_to_default_and_cancel_actions() {
    assert_eq!(
        simple_key_action(&key("return", Vec::new())),
        Some("AXConfirm")
    );
    assert_eq!(
        simple_key_action(&key("enter", Vec::new())),
        Some("AXConfirm")
    );
    assert_eq!(
        simple_key_action(&key("escape", Vec::new())),
        Some("AXCancel")
    );
    assert_eq!(
        simple_key_action(&key("return", vec![Modifier::Meta])),
        None
    );
}

#[test]
fn headless_press_never_performs_menu_shortcuts() {
    let headless = agent_desktop_core::InteractionPolicy::headless();
    assert!(!uses_menu_shortcut(
        &key("n", vec![Modifier::Meta]),
        headless
    ));
    assert!(!uses_menu_shortcut(
        &key("n", vec![Modifier::Meta, Modifier::Shift]),
        headless
    ));
}

#[test]
fn focus_authorized_press_keeps_menu_shortcuts_for_modified_keys() {
    let headed = agent_desktop_core::InteractionPolicy::headed();
    assert!(uses_menu_shortcut(&key("n", vec![Modifier::Meta]), headed));
    assert!(!uses_menu_shortcut(&key("n", Vec::new()), headed));
}

#[test]
fn a_missing_focused_element_names_both_recovery_routes() {
    let error = super::no_focused_element_error(agent_desktop_core::InteractionPolicy::headless());
    let suggestion = error
        .suggestion
        .expect("the error carries a recovery suggestion");
    assert!(suggestion.contains("--headed"), "{suggestion}");
    assert!(suggestion.contains("--surface menubar"), "{suggestion}");
}

#[test]
fn a_headed_missing_focused_element_does_not_suggest_enabling_headed() {
    let error = super::no_focused_element_error(agent_desktop_core::InteractionPolicy::headed());
    let hint = error.suggestion.expect("recovery suggestion");
    assert!(!hint.contains("--headed"), "{hint}");
    assert!(hint.contains("--surface menubar"), "{hint}");
}

#[test]
fn an_unresolvable_key_fails_before_any_focus_change() {
    let pid = std::process::id();
    let instance = crate::system::process::process_identity::token_for_pid(pid as i32)
        .unwrap()
        .unwrap();
    let error = press_for_app_impl(
        ProcessIdentity::new(pid, instance),
        &key("comma", Vec::new()),
        agent_desktop_core::InteractionPolicy::headed(),
        Deadline::standard().unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(
        error.message.contains("keyboard layout"),
        "{}",
        error.message
    );
}
