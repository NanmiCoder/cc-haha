use agent_desktop_core::{AccessibilityNode, ObservationSource, ObservedTree, tree::state};

use super::super::item::ItemEvidence;
use super::super::menu_layout::{Prop, RawEntry, parse};
use super::super::{TrayTarget, identity};
use super::*;

fn target(owner: &str) -> TrayTarget {
    TrayTarget {
        owner: owner.into(),
        object_path: "/StatusNotifierItem".into(),
        menu_path: None,
        entry_id: None,
        label_path: Vec::new(),
    }
}

fn entry(id: i32, label: &str) -> RawEntry {
    RawEntry {
        id,
        props: [("label".to_owned(), Prop::Text(label.into()))]
            .into_iter()
            .collect(),
        children: Vec::new(),
    }
}

fn item(owner: &str, title: &str, passive: bool, methods: &[&str], with_menu: bool) -> TrayItem {
    let layout = with_menu.then(|| {
        parse(&RawEntry {
            id: 0,
            props: Default::default(),
            children: vec![entry(1, "Open"), entry(2, "Quit")],
        })
    });
    TrayItem {
        target: target(owner),
        evidence: ItemEvidence {
            title: title.to_owned(),
            passive,
            menu: with_menu.then(|| "/MenuBar".to_owned()),
            methods: methods.iter().map(|m| (*m).to_owned()).collect(),
        },
        layout,
    }
}

fn view() -> TrayView {
    TrayView {
        items: vec![
            item(":1.1", "System", false, &["Activate", "ContextMenu"], true),
            item(":1.2", "Twin", false, &["Activate"], false),
            item(":1.3", "Twin", false, &["SecondaryActivate"], false),
            item(":1.4", "Slack", true, &[], false),
        ],
    }
}

fn projected() -> Vec<AccessibilityNode> {
    view()
        .subtrees()
        .into_iter()
        .map(|node| {
            ObservedTree::from_roots(
                vec![node],
                ObservationSource::Element {
                    entry: Box::new(crate::tree::live::test_support::ref_entry("group")),
                    root_ref: None,
                },
                Default::default(),
                true,
            )
            .unwrap()
            .into_accessibility_tree()
            .unwrap()
        })
        .collect()
}

#[test]
fn logical_items_do_not_claim_unobserved_offscreen_state() {
    fn check(node: &AccessibilityNode) {
        assert!(
            !node
                .presentation
                .states
                .iter()
                .any(|token| token == state::OFFSCREEN)
        );
        assert!(node.presentation.bounds.is_none());
        for child in &node.children {
            check(child);
        }
    }
    for node in projected() {
        check(&node);
    }
}

#[test]
fn system_and_duplicate_titles_keep_their_protocol_identities_without_native_binding() {
    let nodes = projected();
    assert_eq!(nodes[0].identity.name.as_deref(), Some("System"));
    assert_eq!(
        nodes[0].presentation.available_actions,
        ["Click", "RightClick"]
    );
    assert_eq!(nodes[1].identity.name, nodes[2].identity.name);
    let owner = |node: &AccessibilityNode| {
        identity::decode(&node.identity.native_id.as_ref().unwrap().value)
            .unwrap()
            .owner
    };
    assert_eq!(owner(&nodes[0]), ":1.1");
    assert_ne!(owner(&nodes[1]), owner(&nodes[2]));
    assert!(
        nodes[3]
            .presentation
            .states
            .iter()
            .any(|token| token == state::HIDDEN)
    );
}
