use agent_desktop_core::{AdapterError, WindowInfo, WindowState};

use super::menu_popup::Node;
use super::{MenuPopup, PopupReader, entries_across, entry, find_popups, inventory};
use crate::system::menu::menu_fixture::*;

struct Fake {
    window: Node,
    top: Vec<Node>,
    scans: usize,
    incomplete: bool,
}

impl Fake {
    fn new(window: Node) -> Self {
        Self {
            window,
            top: Vec::new(),
            scans: 0,
            incomplete: false,
        }
    }
}

impl PopupReader for Fake {
    fn incomplete(&self) -> bool {
        self.incomplete
    }

    fn window(&mut self) -> Result<Option<Node>, AdapterError> {
        self.scans += 1;
        Ok(Some(self.window.clone()))
    }

    fn top_levels(&mut self) -> Result<Vec<Node>, AdapterError> {
        Ok(self.top.clone())
    }
}

#[test]
fn a_failed_menu_state_read_never_proves_the_menu_closed() {
    let mut tree = frame_with(vec![gtk4_popover(true)]);
    tree.children[0].payload.node.traits.states = crate::tree::Field::Failed("unread".into());
    let error = inventory(&mut Fake::new(tree))
        .err()
        .expect("a failed read cannot establish absence");
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    let mut closed = Fake::new(frame_with(vec![gtk4_popover(false)]));
    assert!(inventory(&mut closed).unwrap().is_empty());
}

#[test]
fn an_observed_popup_remains_positive_when_other_candidates_are_unread() {
    let mut reader = Fake::new(frame_with(vec![gtk4_popover(true)]));
    reader.incomplete = true;
    let found = find_popups(&mut reader).expect("observed popup");
    assert_eq!(found.len(), 1);
}

#[test]
fn an_unread_menu_inventory_marks_the_window_unclassified() {
    let owner = owner();
    let mut reader = Fake::new(frame_with(Vec::new()));
    let complete = inventory(&mut reader).expect("observed absence");
    assert!(complete.is_empty());
    reader.incomplete = true;
    let menu = entries_across(&[&owner], |_| inventory(&mut reader));
    let window_entry = agent_desktop_core::SurfaceInfo {
        id: owner.id,
        kind: "window".to_owned(),
        title: None,
        item_count: None,
        unclassified: Vec::new(),
    };
    let surfaces = crate::system::menu::surfaces::with_menu_leg(vec![window_entry], menu);
    assert_eq!(surfaces[0].unclassified, ["menu"]);
}

fn owner() -> WindowInfo {
    WindowInfo {
        id: "w-1-2".to_owned(),
        title: "App".to_owned(),
        app: "app".to_owned(),
        pid: 7.into(),
        process_instance: Some("i".to_owned()),
        bounds: None,
        state: WindowState::default(),
    }
}

fn popups(window: Node) -> Vec<MenuPopup> {
    find_popups(&mut Fake::new(window)).expect("a scan")
}

#[test]
fn a_closed_menu_lists_no_entry_though_its_nodes_are_present() {
    let closed = popups(frame_with(vec![qt_bar(false), gtk3_bar(false)]));
    assert!(closed.is_empty());
}

#[test]
fn an_open_menu_lists_one_menu_entry_on_the_owner_window_with_its_item_count() {
    let open = popups(frame_with(vec![gtk4_popover(true)]));
    let entry = entry(&open[0], &owner());
    assert_eq!(entry.id, "w-1-2");
    assert_eq!(entry.kind, "menu");
    assert_eq!(entry.item_count, Some(2));
    assert!(entry.unclassified.is_empty());
}

#[test]
fn the_first_popup_of_a_chain_is_the_outermost_and_the_entry_counts_it() {
    let inner_items = vec![
        item("A", true),
        item("B", true),
        item("C", true),
        item("D", true),
        item("E", true),
    ];
    let inner = node(MENU, "More", &[SHOWING], inner_items);
    let more = node(ITEM, "More", &[SHOWING], vec![inner]);
    let outer = node(MENU, "File", &[SHOWING], vec![item("Open", true), more]);
    let found = popups(frame_with(vec![node(
        MENU_BAR,
        "",
        &[SHOWING],
        vec![outer],
    )]));
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].items, 2);
    assert_eq!(found[1].items, 5);
    assert_eq!(entry(&found[0], &owner()).item_count, Some(2));
}

#[test]
fn a_scan_reads_the_window_once_and_never_waits_for_a_popup_to_open() {
    let mut fake = Fake::new(frame_with(Vec::new()));
    let found = find_popups(&mut fake).expect("a scan");
    assert!(found.is_empty());
    assert_eq!(fake.scans, 1);
}

#[test]
fn a_popup_window_listed_as_a_window_does_not_list_its_own_menu() {
    let found = popups(gtk3_context_window());
    assert!(found.is_empty());
}

fn window_named(id: &str) -> WindowInfo {
    WindowInfo {
        id: id.to_owned(),
        ..owner()
    }
}

#[test]
fn a_top_level_popup_is_listed_once_on_the_first_window_that_sees_it() {
    let (first, second) = (window_named("w-1-1"), window_named("w-1-3"));
    let listed = entries_across(&[&first, &second], |_| {
        find_popups(&mut Fake {
            top: vec![chromium_frame()],
            ..Fake::new(frame_with(Vec::new()))
        })
    })
    .expect("entries");
    let ids: Vec<&str> = listed.iter().map(|entry| entry.id.as_str()).collect();
    assert_eq!(ids, ["w-1-1"]);
}

#[test]
fn an_in_window_popup_is_listed_on_each_window_that_holds_one() {
    let (first, second) = (window_named("w-1-1"), window_named("w-1-3"));
    let listed = entries_across(&[&first, &second], |_| {
        find_popups(&mut Fake::new(frame_with(vec![gtk4_popover(true)])))
    })
    .expect("entries");
    assert_eq!(listed.len(), 2);
}

#[test]
fn a_window_that_sees_no_popup_does_not_claim_a_top_level_one() {
    let (first, second) = (window_named("w-1-1"), window_named("w-1-3"));
    let mut calls = 0;
    let listed = entries_across(&[&first, &second], |_| {
        calls += 1;
        let mut fake = Fake::new(frame_with(Vec::new()));
        if calls == 2 {
            fake.top = vec![gtk3_context_window()];
        }
        find_popups(&mut fake)
    })
    .expect("entries");
    assert_eq!(listed[0].id, "w-1-3");
}

#[test]
fn an_incomplete_popup_scan_never_proves_that_the_popup_is_closed() {
    use crate::tree::Field;
    let mut tree = frame_with(vec![gtk4_popover(true)]);
    assert_eq!(super::roots_in_tree(&tree).expect("open scan").len(), 1);
    tree.children[0].payload.node.traits.states = Field::Failed("read failed".to_owned());
    assert!(super::roots_in_tree(&tree).is_none());
    tree.children.clear();
    tree.payload.node.children = Field::Failed("children unread".to_owned());
    assert!(super::roots_in_tree(&tree).is_none());
}

#[test]
fn an_open_popover_with_only_a_label_is_a_popup_root_below_its_opener() {
    let open = label_popover_opener(true);
    assert_eq!(super::roots_in_tree(&open).expect("complete read").len(), 1);
    let closed = label_popover_opener(false);
    assert!(
        super::roots_in_tree(&closed)
            .expect("complete read")
            .is_empty()
    );
}
