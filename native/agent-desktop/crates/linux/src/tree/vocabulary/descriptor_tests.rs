use std::collections::BTreeMap;

use agent_desktop_core::NodeDescriptor;

use super::descriptors as describe_with;
use crate::tree::live::test_support::attributes;
use crate::tree::vocabulary::placeholder::read_placeholder;
use crate::tree::vocabulary::role_numbers::{CHECK_BOX, ENTRY, PUSH_BUTTON, TEXT};
use crate::tree::{Field, NodeProperties};

fn properties(name: &str, description: &str) -> NodeProperties {
    NodeProperties {
        name: Field::Present(name.to_owned()),
        description: Field::Present(description.to_owned()),
        child_count: Field::Present(0),
        accessible_id: Field::Absent,
    }
}

fn describe(
    role: u32,
    role_name: &str,
    attrs: &Field<BTreeMap<String, String>>,
    in_web_document: bool,
) -> NodeDescriptor {
    describe_with_description(role, role_name, attrs, in_web_document, "")
}

fn describe_with_description(
    role: u32,
    role_name: &str,
    attrs: &Field<BTreeMap<String, String>>,
    in_web_document: bool,
    description: &str,
) -> NodeDescriptor {
    let props = properties("", description);
    let placeholder = read_placeholder(&props, &Field::Present(role), attrs);
    describe_with(
        &Field::Present(role),
        &Field::Present(role_name.to_owned()),
        &placeholder,
        attrs,
        in_web_document,
    )
}

#[test]
fn classes_are_web_only_and_split_on_whitespace() {
    let attrs = attributes(&[("class", "btn  primary\twide")]);
    assert_eq!(
        describe(PUSH_BUTTON, "push button", &attrs, true).dom_classes,
        ["btn", "primary", "wide"]
    );
    assert!(
        describe(PUSH_BUTTON, "push button", &attrs, false)
            .dom_classes
            .is_empty()
    );
}

#[test]
fn subrole_prefers_first_xml_role_then_requires_the_exact_gtk_switch_pair() {
    let xml = attributes(&[("xml-roles", "navigation banner"), ("toolkit", "GTK")]);
    assert_eq!(
        describe(CHECK_BOX, "switch", &xml, true).subrole.as_deref(),
        Some("navigation")
    );

    let gtk = attributes(&[("toolkit", "GTK")]);
    assert_eq!(
        describe(CHECK_BOX, "switch", &gtk, false)
            .subrole
            .as_deref(),
        Some("switch")
    );
    for (role, name, attrs) in [
        (CHECK_BOX, "checkbox", gtk.clone()),
        (PUSH_BUTTON, "switch", gtk),
        (43, "generic", attributes(&[("toolkit", "GTK")])),
        (CHECK_BOX, "switch", attributes(&[("toolkit", "gtk")])),
        (CHECK_BOX, "switch", attributes(&[])),
    ] {
        assert_eq!(describe(role, name, &attrs, false).subrole, None);
    }
}

#[test]
fn author_role_description_and_placeholder_are_optional() {
    let described = attributes(&[("roledescription", "editor"), ("placeholder", "Describe")]);
    let result = describe(ENTRY, "entry", &described, true);
    assert_eq!(result.role_description.as_deref(), Some("editor"));
    assert_eq!(result.placeholder.as_deref(), Some("Describe"));

    let no_description = describe(
        ENTRY,
        "entry",
        &attributes(&[("placeholder-text", "Search")]),
        true,
    );
    assert_eq!(no_description.role_description, None);
    assert_eq!(no_description.placeholder.as_deref(), Some("Search"));

    let gtk = describe_with_description(
        TEXT,
        "text",
        &attributes(&[("toolkit", "GTK")]),
        false,
        "Hint",
    );
    assert_eq!(gtk.placeholder, None);
}
