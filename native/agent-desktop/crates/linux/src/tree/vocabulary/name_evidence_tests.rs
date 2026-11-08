use agent_desktop_core::LocatorField;

use super::name_fields as resolve_names;
use crate::tree::live::test_support::attributes;
use crate::tree::vocabulary::placeholder::read_placeholder;
use crate::tree::vocabulary::role_numbers::{APPLICATION, ENTRY, PUSH_BUTTON, TEXT};
use crate::tree::{Field, LabelOutcome, NodeProperties};

fn name_fields(
    properties: &NodeProperties,
    role: &Field<u32>,
    attributes: &Field<std::collections::BTreeMap<String, String>>,
    label: &LabelOutcome,
) -> (LocatorField<String>, LocatorField<String>) {
    let placeholder = read_placeholder(properties, role, attributes);
    resolve_names(properties, role, &placeholder, label)
}

fn properties(name: Field<String>, description: Field<String>) -> NodeProperties {
    NodeProperties {
        name,
        description,
        child_count: Field::Present(0),
        accessible_id: Field::Absent,
    }
}

fn text(value: &str) -> Field<String> {
    Field::Present(value.to_owned())
}

fn known(value: &str) -> LocatorField<String> {
    LocatorField::Known(value.to_owned())
}

#[test]
fn a_non_blank_name_wins_over_its_label() {
    let (name, _) = name_fields(
        &properties(text("Save"), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Text("Other".to_owned()),
    );
    assert_eq!(name, known("Save"));
}

#[test]
fn a_blank_name_takes_the_label_text() {
    let (name, _) = name_fields(
        &properties(text(""), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Text("Other".to_owned()),
    );
    assert_eq!(name, known("Other"));
}

#[test]
fn a_blank_name_with_a_failed_label_read_is_unknown() {
    let (name, _) = name_fields(
        &properties(text(""), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Failed,
    );
    assert_eq!(name, LocatorField::Unknown);
    let (unlabelled, _) = name_fields(
        &properties(text(""), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(unlabelled, LocatorField::Absent);
}

#[test]
fn a_failed_name_read_is_unknown() {
    let (name, _) = name_fields(
        &properties(Field::Failed("gone".to_owned()), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, LocatorField::Unknown);
}

#[test]
fn the_application_description_is_neither_name_nor_description() {
    let (name, description) = name_fields(
        &properties(text("app"), text("/usr/bin/python3")),
        &Field::Present(APPLICATION),
        &attributes(&[]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, known("app"));
    assert_eq!(description, LocatorField::Absent);
    let (nameless, _) = name_fields(
        &properties(text(""), text("/usr/bin/python3")),
        &Field::Present(APPLICATION),
        &attributes(&[]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(nameless, LocatorField::Absent);
}

#[test]
fn qt_description_on_a_text_input_is_a_placeholder_and_gtk_description_stays_one() {
    let qt = properties(text(""), text("Type name"));
    let (name, description) = name_fields(
        &qt,
        &Field::Present(TEXT),
        &attributes(&[]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, known("Type name"));
    assert_eq!(description, LocatorField::Absent);

    let gtk = properties(text("Search"), text("Type name"));
    let (gtk_name, gtk_description) = name_fields(
        &gtk,
        &Field::Present(TEXT),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(gtk_name, known("Search"));
    assert_eq!(gtk_description, known("Type name"));
}

#[test]
fn qt_description_on_a_button_stays_a_description() {
    let (name, description) = name_fields(
        &properties(text("Press"), text("Tooltip")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[]),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, known("Press"));
    assert_eq!(description, known("Tooltip"));
}

#[test]
fn web_placeholder_attributes_fill_the_placeholder() {
    for (key, value) in [("placeholder", "Describe"), ("placeholder-text", "Search")] {
        let (name, _) = name_fields(
            &properties(text(""), text("")),
            &Field::Present(ENTRY),
            &attributes(&[(key, value), ("tag", "input")]),
            &LabelOutcome::Unlabelled,
        );
        assert_eq!(name, known(value));
    }
}

#[test]
fn a_failed_attribute_read_keeps_description_as_is_and_clouds_the_placeholder() {
    let (name, description) = name_fields(
        &properties(text(""), text("Type name")),
        &Field::Present(TEXT),
        &Field::Failed("gone".to_owned()),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(name, known("Type name"));
    assert_eq!(description, LocatorField::Absent);
    let (silent, _) = name_fields(
        &properties(text(""), text("")),
        &Field::Present(TEXT),
        &Field::Failed("gone".to_owned()),
        &LabelOutcome::Unlabelled,
    );
    assert_eq!(silent, LocatorField::Unknown);
}

#[test]
fn a_failed_name_read_is_not_overridden_by_a_readable_label() {
    let (name, _) = name_fields(
        &properties(Field::Failed("gone".to_owned()), text("")),
        &Field::Present(PUSH_BUTTON),
        &attributes(&[("toolkit", "GTK")]),
        &LabelOutcome::Text("Other".to_owned()),
    );
    assert_eq!(name, LocatorField::Unknown);
}
