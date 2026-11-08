use super::*;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::vocabulary::role_numbers::{DIALOG, FRAME, PANEL};
use crate::tree::vocabulary::state_bits::MODAL;
use crate::tree::{COMPONENT_INTERFACE, Extents, Field};

fn window(role: u32, name: &str, width: i32) -> RawNode {
    let mut node = read_of(role, name, &[]).node;
    node.traits.interfaces = Field::Present(vec![COMPONENT_INTERFACE.into()]);
    node.traits.states = Field::Present(words(&[MODAL, SHOWING]));
    node.extents = Field::Present(Extents {
        x: 0,
        y: 0,
        width,
        height: 636,
    });
    node
}

#[test]
fn an_unnamed_showing_top_level_needs_a_complete_unique_accessible_window_size() {
    let gtk4 = ToolkitId {
        name: Some("GTK".into()),
        version: Some("4.14.5".into()),
    };
    let panel = window(PANEL, "", 702);
    let main = window(FRAME, "Calculator", 360);
    let expected = panel.extents.present().copied();
    assert!(permits_size_match(
        &panel,
        &[main.clone(), panel.clone()],
        &gtk4,
        expected
    ));
    let twin = window(FRAME, "Another window", 702);
    assert!(!permits_size_match(
        &panel,
        &[panel.clone(), twin],
        &gtk4,
        expected
    ));
    let mut unread = main.clone();
    unread.extents = Field::Failed("unread size".into());
    assert!(!permits_size_match(
        &panel,
        &[panel.clone(), unread],
        &gtk4,
        expected
    ));
    let mut unread = main;
    unread.traits.interfaces = Field::Failed("unread interfaces".into());
    assert!(!permits_size_match(
        &panel,
        &[panel.clone(), unread],
        &gtk4,
        expected
    ));
    let plain = window(FRAME, "Named", 702);
    assert!(!permits_size_match(
        &plain,
        std::slice::from_ref(&plain),
        &gtk4,
        expected
    ));
    let mut hidden = panel.clone();
    hidden.traits.states = Field::Present(words(&[MODAL]));
    assert!(!permits_size_match(
        &hidden,
        std::slice::from_ref(&hidden),
        &gtk4,
        expected
    ));
    assert!(!permits_size_match(
        &panel,
        std::slice::from_ref(&panel),
        &ToolkitId {
            name: Some("gtk".into()),
            version: Some("3.24".into())
        },
        expected
    ));
    assert!(!permits_size_match(
        &panel,
        std::slice::from_ref(&panel),
        &gtk4,
        None
    ));
    let resized = Some(Extents {
        x: 0,
        y: 0,
        width: 703,
        height: 636,
    });
    assert!(!permits_size_match(
        &panel,
        std::slice::from_ref(&panel),
        &gtk4,
        resized
    ));
}

#[test]
fn size_identity_uses_component_and_showing_evidence_without_reading_roles() {
    let gtk4 = ToolkitId {
        name: Some("gtk".into()),
        version: Some("4.14".into()),
    };
    for role in [DIALOG, FRAME, 43] {
        let mut node = window(role, "", 702);
        node.traits.states = Field::Present(words(&[SHOWING]));
        let expected = node.extents.present().copied();
        assert!(permits_size_match(
            &node,
            std::slice::from_ref(&node),
            &gtk4,
            expected
        ));
        node.traits.role = Field::Failed("role".into());
        assert!(permits_size_match(
            &node,
            std::slice::from_ref(&node),
            &gtk4,
            expected
        ));
        node.traits.interfaces = Field::Present(vec![]);
        assert!(!permits_size_match(
            &node,
            std::slice::from_ref(&node),
            &gtk4,
            expected
        ));
    }
    let node = window(DIALOG, "", 702);
    let expected = node.extents.present().copied();
    let mut unread = window(43, "Other", 360);
    unread.traits.states = Field::Failed("states".into());
    assert!(!permits_size_match(
        &node,
        &[node.clone(), unread],
        &gtk4,
        expected
    ));
    let twin = window(43, "Other", 702);
    assert!(!permits_size_match(
        &node,
        &[node.clone(), twin],
        &gtk4,
        expected
    ));
    assert!(permits_size_match(
        &node,
        std::slice::from_ref(&node),
        &ToolkitId::default(),
        expected
    ));
}
