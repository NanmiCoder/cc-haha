use agent_desktop_core::{LocatorField, Role};

use super::{resolve_role, role_of};
use crate::tree::live::test_support::{attributes, words};
use crate::tree::vocabulary::state_bits::{EDITABLE, FOCUSABLE, HAS_POPUP, READ_ONLY, SENSITIVE};
use crate::tree::{Field, NodeTraits};

fn states(bits: &[u32]) -> Field<Vec<u32>> {
    Field::Present(words(bits))
}

fn interfaces(names: &[&str]) -> Field<Vec<String>> {
    Field::Present(names.iter().map(|name| (*name).to_owned()).collect())
}

fn plain(number: u32) -> Role {
    role_of(
        number,
        &states(&[SENSITIVE]),
        &interfaces(&[]),
        &attributes(&[]),
    )
}

#[test]
fn unknown_role_numbers_remain_unknown() {
    for number in [130, 131, 1000, u32::MAX] {
        assert_eq!(plain(number), Role::Unknown, "number {number}");
    }
}

#[test]
fn a_list_with_selection_is_a_listbox_otherwise_a_list() {
    let with = interfaces(&["org.a11y.atspi.Accessible", "org.a11y.atspi.Selection"]);
    let without = interfaces(&["org.a11y.atspi.Accessible"]);
    let failed = Field::Failed("gone".to_owned());
    let none = attributes(&[]);
    assert_eq!(role_of(31, &states(&[]), &with, &none), Role::ListBox);
    assert_eq!(role_of(31, &states(&[]), &without, &none), Role::List);
    assert_eq!(role_of(31, &states(&[]), &failed, &none), Role::List);
}

#[test]
fn text_is_a_textfield_only_when_editable() {
    let none = attributes(&[]);
    let none_if = interfaces(&[]);
    for number in [60, 61] {
        if number == 61 {
            assert_eq!(
                role_of(number, &states(&[EDITABLE]), &none_if, &none),
                Role::TextField
            );
        }
        assert_eq!(
            role_of(number, &states(&[SENSITIVE]), &none_if, &none),
            Role::Document
        );
        let failed = Field::Failed("gone".to_owned());
        assert_eq!(role_of(number, &failed, &none_if, &none), Role::Document);
    }
}

#[test]
fn a_focusable_terminal_is_a_textfield_and_one_that_cannot_take_keys_is_a_document() {
    let none = attributes(&[]);
    let none_if = interfaces(&[]);
    assert_eq!(
        role_of(60, &states(&[FOCUSABLE, SENSITIVE]), &none_if, &none),
        Role::TextField
    );
    assert_eq!(
        role_of(60, &states(&[SENSITIVE]), &none_if, &none),
        Role::Document
    );
    assert_eq!(
        role_of(60, &states(&[FOCUSABLE, READ_ONLY]), &none_if, &none),
        Role::Document
    );
    assert_eq!(
        role_of(61, &states(&[FOCUSABLE]), &none_if, &none),
        Role::Document
    );
}

#[test]
fn a_push_button_with_a_popup_is_a_menubutton() {
    let none = attributes(&[]);
    let none_if = interfaces(&[]);
    assert_eq!(
        role_of(43, &states(&[HAS_POPUP]), &none_if, &none),
        Role::MenuButton
    );
    assert_eq!(
        role_of(43, &states(&[SENSITIVE]), &none_if, &none),
        Role::Button
    );
    let failed = Field::Failed("gone".to_owned());
    assert_eq!(role_of(43, &failed, &none_if, &none), Role::Button);
}

#[test]
fn a_landmark_takes_its_xml_role_when_listed_and_is_a_region_otherwise() {
    let none_if = interfaces(&[]);
    let landmark =
        |pairs: &[(&str, &str)]| role_of(110, &states(&[]), &none_if, &attributes(pairs));
    assert_eq!(landmark(&[("xml-roles", "navigation")]), Role::Navigation);
    assert_eq!(
        landmark(&[("xml-roles", "Contentinfo extra")]),
        Role::ContentInfo
    );
    assert_eq!(landmark(&[("xml-roles", "region")]), Role::Region);
    assert_eq!(landmark(&[]), Role::Region);
    let failed = Field::Failed("gone".to_owned());
    assert_eq!(role_of(110, &states(&[]), &none_if, &failed), Role::Region);
}

#[test]
fn a_failed_role_read_is_unknown_not_the_unknown_role() {
    let mut traits = NodeTraits::failed("gone");
    assert_eq!(
        resolve_role(&traits, &attributes(&[])),
        LocatorField::Unknown
    );
    traits.role = Field::Present(0);
    assert_eq!(
        resolve_role(&traits, &attributes(&[])),
        LocatorField::Known("unknown".to_owned())
    );
}

fn traits_of(number: u32, role_name: &str) -> NodeTraits {
    NodeTraits {
        role: Field::Present(number),
        role_name: Field::Present(role_name.to_owned()),
        states: states(&[SENSITIVE]),
        interfaces: interfaces(&[]),
    }
}

fn role_token(traits: &NodeTraits, pairs: &[(&str, &str)]) -> LocatorField<String> {
    resolve_role(traits, &attributes(pairs))
}

#[test]
fn a_gtk_switch_resolves_switch_and_every_other_check_box_stays_checkbox() {
    let switch = LocatorField::Known("switch".to_owned());
    let checkbox = LocatorField::Known("checkbox".to_owned());
    assert_eq!(
        role_token(&traits_of(7, "switch"), &[("toolkit", "GTK")]),
        switch
    );
    assert_eq!(
        role_token(&traits_of(7, "switch"), &[("toolkit", "Qt")]),
        checkbox
    );
    assert_eq!(role_token(&traits_of(7, "switch"), &[]), checkbox);
    assert_eq!(
        role_token(&traits_of(7, "check box"), &[("toolkit", "GTK")]),
        checkbox
    );
    assert_eq!(
        role_token(&traits_of(43, "switch"), &[("toolkit", "GTK")]),
        LocatorField::Known("button".to_owned())
    );
}

#[test]
fn a_number_refuted_by_may_resolve_to_never_resolves_to_that_role() {
    let state_sets = [
        states(&[]),
        states(&[EDITABLE]),
        states(&[FOCUSABLE]),
        states(&[HAS_POPUP]),
        states(&[READ_ONLY]),
    ];
    let interface_sets = [
        interfaces(&[]),
        interfaces(&["org.a11y.atspi.Selection"]),
        Field::Failed("gone".to_owned()),
    ];
    let attribute_sets = [attributes(&[]), attributes(&[("xml-roles", "banner")])];
    for number in 0..140 {
        for state in &state_sets {
            for interface in &interface_sets {
                for attribute in &attribute_sets {
                    let role = role_of(number, state, interface, attribute);
                    assert!(
                        super::may_resolve_to(number, role.as_str()),
                        "number {number} resolved to {}",
                        role.as_str()
                    );
                }
            }
        }
    }
}

#[test]
fn a_push_button_number_refutes_a_checkbox_and_a_checkbox_number_admits_a_switch() {
    assert!(!super::may_resolve_to(43, "checkbox"));
    assert!(super::may_resolve_to(43, "button"));
    assert!(super::may_resolve_to(43, "menubutton"));
    assert!(super::may_resolve_to(7, "switch"));
    assert!(!super::may_resolve_to(7, "button"));
}
