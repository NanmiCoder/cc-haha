use agent_desktop_core::{Action, LocatorField};

use super::{capabilities, capability_of, click_verbs, verbs_for};
use crate::tree::Field;
use crate::tree::RawNode;
use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::{CHECK_BOX, LIST_ITEM};
use crate::tree::vocabulary::role_numbers::{MENU_ITEM, PUSH_BUTTON};
use crate::tree::vocabulary::state_bits::{CHECKABLE, SELECTABLE};

fn node(actions: &[&str]) -> RawNode {
    read_of(PUSH_BUTTON, "n", actions).node
}

fn known(node: &RawNode) -> Vec<String> {
    match capabilities(node) {
        LocatorField::Known(tokens) => tokens,
        other => panic!("expected a known capability list, got {other:?}"),
    }
}

#[test]
fn selectable_uncheckable_options_advertise_selection_without_toggle_or_click() {
    for (role, selectable, checkable, expected) in [
        (LIST_ITEM, true, false, "Select"),
        (LIST_ITEM, true, true, "Toggle"),
        (LIST_ITEM, false, false, "Toggle"),
        (CHECK_BOX, true, true, "Toggle"),
    ] {
        let mut raw = read_of(role, "option", &["Toggle"]).node;
        let mut words = vec![0, 0];
        if selectable {
            words[0] |= 1 << SELECTABLE;
        }
        if checkable {
            words[1] |= 1 << (CHECKABLE - 32);
        }
        raw.traits.states = Field::Present(words);
        let tokens = known(&raw);
        assert!(tokens.iter().any(|token| token == expected));
        if expected == "Select" {
            assert!(
                !tokens
                    .iter()
                    .any(|token| token == "Toggle" || token == "Click")
            );
        } else {
            assert_eq!(
                tokens.iter().any(|token| token == "Select"),
                role == LIST_ITEM && selectable
            );
        }
    }
}

#[test]
fn representative_names_have_fixed_capabilities() {
    let cases = [
        ("click", &["Click"][..]),
        ("Activate", &["Click"][..]),
        ("PRESS", &["Click"][..]),
        ("open", &["Click"][..]),
        ("jump", &["Click"][..]),
        ("check", &["Toggle", "Click"][..]),
        ("Toggle", &["Toggle"][..]),
        ("uncheck", &["Toggle"][..]),
        ("select", &["Select"][..]),
        ("showContextMenu", &["RightClick"][..]),
        ("ShowMenu", &["RightClick"][..]),
        ("menu.popup", &["RightClick"][..]),
        ("SetFocus", &[][..]),
        ("CLICKANCESTOR", &["Click"][..]),
        ("doDefault", &[][..]),
        ("clipboard.copy", &[][..]),
        ("window.close", &[][..]),
        ("listitem.toggle-expand", &[][..]),
    ];
    for (name, expected) in cases {
        assert_eq!(capability_of(name), expected, "{name}");
    }
}

#[test]
fn composition_unknown_empty_and_first_appearance_are_stable() {
    assert_eq!(
        known(&node(&["clickAncestor", "showContextMenu"])),
        ["Click", "RightClick"]
    );
    assert_eq!(
        known(&node(&["menu.popup", "click", "press"])),
        ["RightClick", "Click"]
    );
    assert!(known(&node(&["doDefault"])).is_empty());
    assert!(known(&node(&[])).is_empty());

    let mut absent = node(&[]);
    absent.actions = Field::Absent;
    assert!(known(&absent).is_empty());

    for failed in ["actions", "role", "states"] {
        let mut raw = node(&["click"]);
        match failed {
            "actions" => raw.actions = Field::Failed("x".to_owned()),
            "role" => raw.traits.role = Field::Failed("x".to_owned()),
            _ => raw.traits.states = Field::Failed("x".to_owned()),
        }
        assert_eq!(capabilities(&raw), LocatorField::Unknown, "{failed}");
    }
}

#[test]
fn dispatch_verb_orders_are_fixed() {
    assert_eq!(
        verbs_for(&Action::Click),
        [
            "click",
            "press",
            "activate",
            "open",
            "jump",
            "check",
            "clickAncestor"
        ]
    );
    assert_eq!(click_verbs(Some(MENU_ITEM)).last(), Some(&"ShowMenu"));
    assert_eq!(click_verbs(Some(PUSH_BUTTON)), verbs_for(&Action::Click));
    assert_eq!(click_verbs(None), verbs_for(&Action::Click));
    assert_eq!(
        verbs_for(&Action::RightClick),
        ["showContextMenu", "menu", "ShowMenu", "menu.popup"]
    );
    assert_eq!(
        verbs_for(&Action::Check),
        ["check", "toggle", "switch", "click"]
    );
    assert_eq!(
        verbs_for(&Action::Uncheck),
        ["uncheck", "toggle", "switch", "click", "check"]
    );
    assert_eq!(
        verbs_for(&Action::Toggle),
        ["toggle", "switch", "click", "check", "uncheck"]
    );
    assert_eq!(
        verbs_for(&Action::Expand),
        [
            "listitem.toggle-expand",
            "listitem.expand",
            "click",
            "press",
            "activate"
        ]
    );
    assert_eq!(
        verbs_for(&Action::Collapse),
        [
            "listitem.toggle-expand",
            "listitem.collapse",
            "click",
            "press",
            "activate"
        ]
    );
    assert!(verbs_for(&Action::Hover).is_empty());
    assert!(verbs_for(&Action::Clear).is_empty());
    assert!(verbs_for(&Action::SetFocus).is_empty());
}
