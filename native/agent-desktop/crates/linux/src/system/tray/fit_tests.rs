use agent_desktop_core::{
    AccessibilityNode, ObservationSource, ObservedTree, ProcessId, RefEntry, SnapshotSurface,
    WindowInfo, WindowState, refs::ref_alloc::is_ref_able,
};

use super::item::ItemEvidence;
use super::menu_layout::{Prop, RawEntry, parse};
use super::node_evidence::SEPARATOR_ROLE;
use super::tray_item::TrayItem;
use super::view::TrayView;
use super::{TrayTarget, owns, resolve};
use crate::tree::live::test_support::ref_entry;

fn raw(id: i32, label: &str, extra: &[(&str, Prop)], children: Vec<RawEntry>) -> RawEntry {
    let mut props: std::collections::HashMap<String, Prop> = extra
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect();
    props.insert("label".into(), Prop::Text(label.into()));
    RawEntry {
        id,
        props,
        children,
    }
}

fn projected() -> AccessibilityNode {
    let layout = parse(&raw(
        0,
        "",
        &[],
        vec![
            raw(1, "Open", &[], vec![]),
            raw(2, "", &[("type", Prop::Text("separator".into()))], vec![]),
            raw(3, "Off", &[("enabled", Prop::Flag(false))], vec![]),
            raw(4, "More", &[], vec![raw(5, "Deep", &[], vec![])]),
        ],
    ));
    let item = TrayItem {
        target: TrayTarget {
            owner: ":1.7".into(),
            object_path: "/org/ayatana/NotificationItem/x".into(),
            menu_path: None,
            entry_id: None,
            label_path: Vec::new(),
        },
        evidence: ItemEvidence {
            title: "Dropbox".into(),
            passive: false,
            menu: Some("/MenuBar".into()),
            methods: vec!["Activate".into()],
        },
        layout: Some(layout),
    };
    let view = TrayView { items: vec![item] };
    let root = view.subtrees().pop().expect("one watcher item");
    let window = WindowInfo {
        id: "w-1".into(),
        title: "Tray".into(),
        app: "shell".into(),
        pid: ProcessId::new(42),
        process_instance: Some("instance".into()),
        bounds: None,
        state: WindowState::default(),
    };
    ObservedTree::from_roots(
        vec![root],
        ObservationSource::Window {
            window,
            surface: SnapshotSurface::Window,
        },
        Default::default(),
        true,
    )
    .expect("the tray subtrees form a tree")
    .into_accessibility_tree()
    .expect("the tree projects")
}

fn nodes(node: &AccessibilityNode, found: &mut Vec<AccessibilityNode>) {
    found.push(node.clone());
    for child in &node.children {
        nodes(child, found);
    }
}

fn all() -> Vec<AccessibilityNode> {
    let mut found = Vec::new();
    nodes(&projected(), &mut found);
    found
}

fn stored(node: &AccessibilityNode) -> RefEntry {
    let mut entry = ref_entry(&node.role);
    entry.identity.name = node.identity.name.clone();
    entry.identity.native_id = node.identity.native_id.clone();
    entry
}

#[test]
fn every_node_carries_a_tray_identity_that_its_stored_ref_owns() {
    for node in all().iter() {
        let entry = stored(node);
        assert!(owns(&entry), "{}", node.role);
        assert!(resolve::target_of_entry(&entry).is_ok(), "{}", node.role);
    }
}

#[test]
fn a_nested_entry_ref_decodes_to_its_label_path_id_and_menu() {
    let deep = all()
        .into_iter()
        .find(|node| node.identity.name.as_deref() == Some("Deep"))
        .expect("the nested entry is projected");
    let target = resolve::target_of_entry(&stored(&deep)).expect("decodes");
    assert_eq!(target.label_path, ["More", "Deep"]);
    assert_eq!(target.entry_id, Some(5));
    assert_eq!(target.menu_path.as_deref(), Some("/MenuBar"));
    assert_eq!(target.owner, ":1.7");
}

#[test]
fn an_item_ref_decodes_to_the_unique_owner_and_path() {
    let root = projected();
    let target = resolve::target_of_entry(&stored(&root)).expect("decodes");
    assert_eq!(target.owner, ":1.7");
    assert_eq!(target.object_path, "/org/ayatana/NotificationItem/x");
    assert_eq!(target.entry_id, None);
}

#[test]
fn an_enabled_entry_and_an_item_with_activate_are_ref_able_with_a_click() {
    let nodes = all();
    let open = nodes
        .iter()
        .find(|node| node.identity.name.as_deref() == Some("Open"))
        .expect("Open is projected");
    assert!(is_ref_able(open));
    assert_eq!(open.presentation.available_actions, ["Click"]);
    assert!(is_ref_able(&nodes[0]));
    assert_eq!(nodes[0].presentation.available_actions, ["Click"]);
}

#[test]
fn a_disabled_entry_advertises_click_with_its_disabled_state_and_a_separator_none() {
    let nodes = all();
    let off = nodes
        .iter()
        .find(|node| node.identity.name.as_deref() == Some("Off"))
        .expect("Off is projected");
    assert_eq!(off.presentation.available_actions, ["Click"]);
    assert!(
        off.presentation
            .states
            .iter()
            .any(|state| state == "disabled")
    );
    let separator = nodes
        .iter()
        .find(|node| node.role == SEPARATOR_ROLE)
        .expect("the separator is projected");
    assert!(separator.presentation.available_actions.is_empty());
    assert!(!is_ref_able(separator));
}

#[test]
fn a_tray_node_projects_no_bounds_of_its_own_and_none_are_invented() {
    let nodes = all();
    assert!(
        nodes
            .iter()
            .skip(1)
            .all(|node| node.presentation.bounds.is_none())
    );
}
