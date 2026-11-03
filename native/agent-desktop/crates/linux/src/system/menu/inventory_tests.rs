use agent_desktop_core::{AdapterError, ErrorCode, WindowInfo, WindowState};

use super::{Nested, scan_windows};
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::FrameFacts;
use crate::tree::live::test_support::{read_of, words};
use crate::tree::surfaces::nested_dialog::Node;
use crate::tree::vocabulary::role_numbers::{ALERT, DIALOG, FRAME, NOTIFICATION, PANEL, WINDOW};
use crate::tree::vocabulary::state_bits::SHOWING;
use crate::tree::{AtspiElement, Field, WalkedNode};

fn window(id: &str, sheet: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: id.to_owned(),
            title: "App".to_owned(),
            app: "app".to_owned(),
            pid: 7.into(),
            process_instance: Some("boot:7".to_owned()),
            bounds: None,
            state: WindowState::default(),
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 7,
            title: "App".to_owned(),
            extents: None,
            global_position: false,
        },
        sheet,
        unshown: false,
    }
}

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

fn tree_with(showing: bool) -> Node {
    let dialog = node(DIALOG, "About", showing, "/org/dlg_1", Vec::new());
    node(
        FRAME,
        "App",
        true,
        "/org/win_1",
        vec![node(PANEL, "", true, "/org/p_1", vec![dialog])],
    )
}

const WINDOW_ID: &str = "w-1.2-org-win_1";

#[test]
fn a_showing_dialog_inside_a_window_is_found_under_its_own_address_and_not_the_windows() {
    let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(tree_with(true)));
    assert!(scan.complete);
    assert_eq!(
        scan.found,
        [Nested {
            window: 0,
            id: "w-1.2-org-dlg_1".to_owned(),
            title: Some("About".to_owned()),
        }]
    );
    assert_ne!(scan.found[0].id, WINDOW_ID);
}

#[test]
fn the_same_dialog_without_showing_is_not_found_whether_or_not_its_node_stays() {
    let stays = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(tree_with(false)));
    assert!(stays.found.is_empty());
    let gone = scan_windows(&[window(WINDOW_ID, false)], |_| {
        Ok(node(FRAME, "App", true, "/org/win_1", Vec::new()))
    });
    assert!(gone.found.is_empty() && gone.complete);
}

#[test]
fn a_window_that_is_itself_a_dialog_is_not_scanned() {
    let scan = scan_windows(&[window(WINDOW_ID, true)], |_| {
        panic!("a sheet window is listed as a sheet already")
    });
    assert!(scan.found.is_empty() && scan.complete);
}

#[test]
fn a_tree_cut_short_by_the_budget_marks_the_scan_incomplete() {
    let mut cut = tree_with(false);
    cut.children[0].truncated = true;
    let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(cut.clone()));
    assert!(!scan.complete);
    assert_eq!(scan.unread, [0]);
}

#[test]
fn a_window_that_cannot_be_read_marks_the_scan_incomplete_and_keeps_the_others() {
    let windows = [window("w-1.2-org-win_9", false), window(WINDOW_ID, false)];
    let scan = scan_windows(&windows, |element| {
        if element.path() == "/org/win_9" {
            Err(AdapterError::new(ErrorCode::Timeout, "slow"))
        } else {
            Ok(tree_with(true))
        }
    });
    assert!(!scan.complete);
    assert_eq!(scan.found.len(), 1);
    assert_eq!(scan.found[0].window, 1);
}

#[test]
fn a_window_id_this_adapter_did_not_issue_marks_the_scan_incomplete() {
    let scan = scan_windows(&[window("not-an-id", false)], |_| Ok(tree_with(true)));
    assert!(!scan.complete && scan.found.is_empty());
}

fn menu_window_tree() -> Node {
    let item = node(35, "Paste", true, "/org/m_item", Vec::new());
    let menu = node(33, "", true, "/org/m_1", vec![item]);
    let mut window = node(WINDOW, "", true, "/org/menu_1", vec![menu]);
    window.payload.node.traits.interfaces =
        Field::Present(vec![crate::tree::COMPONENT_INTERFACE.to_owned()]);
    window
}

#[test]
fn a_window_that_is_itself_a_menu_is_one_menu_signal_on_the_windows_id() {
    let scan = scan_windows(&[window("w-1.2-org-menu_1", false)], |_| {
        Ok(menu_window_tree())
    });
    assert!(scan.complete);
    assert_eq!(scan.menus.len(), 1);
    assert_eq!(scan.menus[0].id, "w-1.2-org-menu_1");
    assert_eq!(scan.menus[0].title, None);
}

#[test]
fn a_menu_drawn_inside_a_window_is_found_on_its_own_address() {
    let item = node(35, "Copy", true, "/org/m_item", Vec::new());
    let menu = node(33, "", true, "/org/m_2", vec![item]);
    let frame = node(FRAME, "App", true, "/org/win_1", vec![menu]);
    let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(frame.clone()));
    assert!(scan.complete);
    assert_eq!(scan.menus.len(), 1);
    assert_eq!(scan.menus[0].id, "w-1.2-org-m_2");
}

#[test]
fn an_idle_window_reports_no_menu() {
    let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(tree_with(true)));
    assert!(scan.menus.is_empty());
}

#[test]
fn unread_menu_state_keeps_surface_inventory_incomplete() {
    let mut tree = menu_window_tree();
    tree.children[0].payload.node.traits.states = Field::Failed("state unavailable".into());
    let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(tree.clone()));
    assert!(scan.menus.is_empty());
    assert!(!scan.complete);
    assert_eq!(scan.unread, [0]);
}

#[test]
fn an_alert_inside_a_window_is_a_sheet_and_a_notification_is_not() {
    for (role, found) in [(ALERT, 1), (NOTIFICATION, 0)] {
        let alert = node(role, "Save Changes?", true, "/org/alert_1", Vec::new());
        let tree = node(FRAME, "App", true, "/org/win_1", vec![alert]);
        let scan = scan_windows(&[window(WINDOW_ID, false)], |_| Ok(tree.clone()));
        assert!(scan.complete);
        assert_eq!(scan.found.len(), found);
        if found == 1 {
            assert_eq!(scan.found[0].title.as_deref(), Some("Save Changes?"));
            assert_eq!(scan.found[0].id, "w-1.2-org-alert_1");
        }
    }
}
