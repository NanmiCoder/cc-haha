use agent_desktop_core::LocatorField;

use super::{classify, is_wrapper_shape};
use crate::tree::capabilities::value_read::ValueRead;
use crate::tree::vocabulary::role_numbers::{
    DOCUMENT_FRAME, DOCUMENT_WEB, FILLER, PANEL, PUSH_BUTTON, SECTION,
};
use crate::tree::{AtspiElement, Field, NodeProperties, ObservedRead, RawNode};

fn properties(name: Field<String>, accessible_id: Field<String>) -> NodeProperties {
    NodeProperties {
        name,
        description: Field::Present(String::new()),
        child_count: Field::Present(1),
        accessible_id,
    }
}

fn blank() -> NodeProperties {
    properties(Field::Present(String::new()), Field::Present(String::new()))
}

fn caps(tokens: &[&str]) -> LocatorField<Vec<String>> {
    LocatorField::Known(tokens.iter().map(|token| (*token).to_owned()).collect())
}

fn shape(
    role: u32,
    props: &NodeProperties,
    value: &ValueRead,
    actions: &LocatorField<Vec<String>>,
) -> bool {
    is_wrapper_shape(&Field::Present(role), props, value, actions)
}

fn read_with(role: u32, actions: Field<Vec<String>>) -> ObservedRead {
    let mut node = RawNode::unreadable(AtspiElement::new(":1.1", "/p", 1), "unused");
    node.traits.role = Field::Present(role);
    node.traits.states = Field::Present(vec![0, 0]);
    node.properties = blank();
    node.actions = actions;
    ObservedRead::plain(node)
}

#[test]
fn wrapper_shape_and_classification_matrix() {
    let absent = ValueRead::absent();
    let no_actions = caps(&[]);
    for role in [PANEL, SECTION, FILLER] {
        assert!(shape(role, &blank(), &absent, &no_actions), "role {role}");
    }
    assert!(shape(
        PANEL,
        &blank(),
        &absent,
        &caps(&["RightClick", "SetFocus", "ScrollTo"]),
    ));
    assert!(!shape(
        PANEL,
        &blank(),
        &absent,
        &caps(&["RightClick", "Click"])
    ));
    assert!(!shape(
        PANEL,
        &properties(Field::Present("Sidebar".to_owned()), Field::Absent),
        &absent,
        &no_actions
    ));
    assert!(!shape(
        PANEL,
        &properties(Field::Absent, Field::Present("main-content".to_owned())),
        &absent,
        &no_actions
    ));
    let valued = ValueRead {
        value: Field::Present("3".to_owned()),
        truncated: false,
    };
    assert!(!shape(PANEL, &blank(), &valued, &no_actions));
    assert!(!shape(
        PANEL,
        &properties(Field::Failed("timed out".to_owned()), Field::Absent),
        &absent,
        &no_actions
    ));
    assert!(!shape(PANEL, &blank(), &absent, &LocatorField::Unknown));
    assert!(!is_wrapper_shape(
        &Field::Failed("x".to_owned()),
        &blank(),
        &absent,
        &no_actions
    ));
    assert!(!shape(PUSH_BUTTON, &blank(), &absent, &no_actions));

    assert!(
        classify(&read_with(
            PANEL,
            Field::Present(vec!["showContextMenu".to_owned()])
        ))
        .wrapper
    );
    assert!(!classify(&read_with(PANEL, Field::Present(vec!["click".to_owned()]))).wrapper);
    assert!(
        classify(&read_with(
            PANEL,
            Field::Present(vec!["doDefault".to_owned(), "showContextMenu".to_owned()])
        ))
        .wrapper
    );
    assert!(!classify(&read_with(PANEL, Field::Failed("x".to_owned()))).wrapper);
    assert!(classify(&read_with(DOCUMENT_WEB, Field::Absent)).web_document);
    assert!(classify(&read_with(DOCUMENT_FRAME, Field::Absent)).web_document);
    assert!(!classify(&read_with(PANEL, Field::Absent)).web_document);
}
