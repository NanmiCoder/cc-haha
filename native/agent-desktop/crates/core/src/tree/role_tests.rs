use super::*;

#[test]
fn structural_roles_are_canonical_but_not_interactive() {
    for token in ["row", "scrollbar", "tablist"] {
        let role = Role::from_token(token);
        assert_eq!(role.as_str(), token);
        assert!(Role::is_canonical(token));
        assert!(!role.is_interactive());
    }
}

#[test]
fn unknown_tokens_fail_closed_to_unknown() {
    assert_eq!(Role::from_token("buttn"), Role::Unknown);
    assert_eq!(Role::from_token(""), Role::Unknown);
    assert_eq!(Role::Unknown.as_str(), "unknown");
}

#[test]
fn canonical_tokens_round_trip() {
    for token in [
        "alert",
        "alertdialog",
        "application",
        "article",
        "banner",
        "button",
        "checkbox",
        "complementary",
        "contentinfo",
        "definition",
        "dialog",
        "form",
        "group",
        "listbox",
        "log",
        "main",
        "marquee",
        "math",
        "menuitem",
        "navigation",
        "note",
        "option",
        "radiogroup",
        "region",
        "search",
        "statictext",
        "tabpanel",
        "textfield",
        "term",
        "timer",
        "webarea",
        "window",
        "unknown",
    ] {
        assert_eq!(Role::from_token(token).as_str(), token);
        assert!(Role::is_canonical(token));
    }
}

#[test]
fn interactive_classification_is_owned_by_role() {
    assert!(Role::Button.is_interactive());
    assert!(Role::TextField.is_interactive());
    assert!(!Role::Group.is_interactive());
    assert!(!Role::StaticText.is_interactive());
}
