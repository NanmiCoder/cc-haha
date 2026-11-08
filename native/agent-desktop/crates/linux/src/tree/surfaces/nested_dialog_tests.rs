use super::{Node, find, is_cut_short, is_incomplete};
use crate::tree::live::test_support::{read_of, words};
use crate::tree::vocabulary::role_numbers::{ALERT, DIALOG, FRAME, NOTIFICATION, PANEL};
use crate::tree::vocabulary::state_bits::SHOWING;
use crate::tree::{AtspiElement, Field, WalkedNode};

fn node(role: u32, name: &str, showing: bool, path: &str, children: Vec<Node>) -> Node {
    let mut read = read_of(role, name, &[]);
    read.node.element = AtspiElement::new(":1.2", path, 7);
    let bits: &[u32] = if showing { &[SHOWING] } else { &[] };
    read.node.traits.states = Field::Present(words(bits));
    WalkedNode {
        payload: read,
        children,
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

fn window(children: Vec<Node>) -> Node {
    node(FRAME, "App", true, "/w", children)
}

fn deep_dialog(showing: bool) -> Node {
    let dialog = node(DIALOG, "About", showing, "/d", Vec::new());
    let inner = node(PANEL, "", true, "/p2", vec![dialog]);
    node(PANEL, "", true, "/p1", vec![inner])
}

#[test]
fn a_showing_dialog_below_the_window_is_found_with_its_address_and_title() {
    let tree = window(vec![deep_dialog(true)]);
    let found = find(&tree);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].element.path(), "/d");
    assert_eq!(found[0].title, Some("About"));
}

#[test]
fn a_dialog_that_stays_in_the_tree_without_showing_is_not_found() {
    assert!(find(&window(vec![deep_dialog(false)])).is_empty());
}

#[test]
fn a_dialog_that_left_the_tree_is_not_found() {
    let tree = window(vec![node(PANEL, "", true, "/p1", Vec::new())]);
    assert!(find(&tree).is_empty());
}

#[test]
fn the_window_root_is_never_a_nested_dialog() {
    let root = node(DIALOG, "About", true, "/w", Vec::new());
    assert!(find(&root).is_empty());
}

#[test]
fn only_the_outermost_of_nested_dialogs_is_found() {
    let inner = node(DIALOG, "Inner", true, "/inner", Vec::new());
    let outer = node(DIALOG, "Outer", true, "/outer", vec![inner]);
    let tree = window(vec![outer]);
    let found = find(&tree);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].element.path(), "/outer");
}

#[test]
fn a_blank_name_is_no_title() {
    let tree = window(vec![node(DIALOG, "", true, "/d", Vec::new())]);
    assert_eq!(find(&tree)[0].title, None);
}

#[test]
fn a_dialog_inside_a_web_document_is_not_found() {
    let mut inside = node(DIALOG, "page dialog", true, "/d", Vec::new());
    inside.in_web_document = true;
    assert!(find(&window(vec![inside])).is_empty());
}

#[test]
fn a_walk_with_an_unread_subtree_is_cut_short() {
    let mut cut = node(PANEL, "", true, "/p", Vec::new());
    cut.truncated = true;
    assert!(is_cut_short(&window(vec![cut])));
    let mut cut = node(PANEL, "", true, "/p", Vec::new());
    cut.child_count = Some(1);
    assert!(is_cut_short(&window(vec![cut])));
    assert!(!is_cut_short(&window(vec![deep_dialog(true)])));
}

#[test]
fn a_showing_alert_below_the_window_is_found_with_its_address_and_title() {
    let alert = node(ALERT, "Save Changes?", true, "/a", Vec::new());
    let tree = window(vec![node(PANEL, "", true, "/p", vec![alert])]);
    let found = find(&tree);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].element.path(), "/a");
    assert_eq!(found[0].title, Some("Save Changes?"));
}

#[test]
fn an_alert_that_does_not_show_and_a_notification_are_not_found() {
    for (role, showing) in [(ALERT, false), (NOTIFICATION, true)] {
        let tree = window(vec![node(role, "Heads up", showing, "/a", Vec::new())]);
        assert!(find(&tree).is_empty());
    }
}

#[test]
fn an_alert_whose_states_never_read_leaves_discovery_incomplete() {
    let read = |states: Field<Vec<u32>>| {
        let mut alert = node(ALERT, "Save", true, "/a", Vec::new());
        alert.payload.node.traits.states = states;
        is_incomplete(&window(vec![alert]))
    };
    assert!(read(Field::Failed("unread".into())));
    assert!(!read(Field::Present(words(&[SHOWING]))));
}

#[test]
fn alert_discovery_reads_beyond_an_ordinary_dialog() {
    use agent_desktop_core::SnapshotSurface::Alert;
    let alert = node(ALERT, "Warning", true, "/a", Vec::new());
    let outer = node(DIALOG, "Outer", true, "/d", vec![alert]);
    let mut tree = window(vec![outer]);
    assert_eq!(super::find_surface(&tree, Alert)[0].element.path(), "/a");
    assert!(!super::is_incomplete_surface(&tree, Alert));
    tree.children[0].children[0].payload.node.traits.states = Field::Failed("unread".into());
    assert!(super::is_incomplete_surface(&tree, Alert));
    assert!(!is_incomplete(&tree));
}
