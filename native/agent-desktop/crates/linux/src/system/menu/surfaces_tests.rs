use agent_desktop_core::{WindowInfo, WindowState};

use super::{surfaces_of, with_menu_leg};
use crate::system::registry::listed_window::ListedWindow;
use crate::system::x11::FrameFacts;
use agent_desktop_core::{AdapterError, ErrorCode};

fn window(id: &str, title: &str, sheet: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: id.to_owned(),
            title: title.to_owned(),
            app: "a".to_owned(),
            pid: 7.into(),
            process_instance: Some("i".to_owned()),
            bounds: None,
            state: WindowState::default(),
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 7,
            title: title.to_owned(),
            extents: None,
            global_position: true,
        },
        sheet,
        unshown: false,
    }
}

#[test]
fn every_window_lists_a_window_surface_with_its_id_and_title() {
    let surfaces = surfaces_of(&[window("w-1", "Doc", false)]);
    let [surface] = surfaces.as_slice() else {
        panic!("one surface")
    };
    assert_eq!(surface.id, "w-1");
    assert_eq!(surface.kind, "window");
    assert_eq!(surface.title.as_deref(), Some("Doc"));
}

#[test]
fn a_modal_dialog_also_lists_a_sheet_surface_on_the_same_id() {
    let surfaces = surfaces_of(&[window("w-1", "Save", true)]);
    let kinds: Vec<&str> = surfaces
        .iter()
        .map(|surface| surface.kind.as_str())
        .collect();
    assert_eq!(kinds, ["window", "sheet"]);
    assert!(surfaces.iter().all(|surface| surface.id == "w-1"));
}

#[test]
fn an_untitled_window_lists_no_title() {
    let surfaces = surfaces_of(&[window("w-1", "", false)]);
    assert_eq!(surfaces[0].title, None);
}

#[test]
fn a_failed_menu_scan_keeps_the_window_and_sheet_entries_and_marks_the_menu_unread() {
    let surfaces = surfaces_of(&[window("w-1", "Doc", true)]);
    let kept = with_menu_leg(
        surfaces,
        Err(AdapterError::new(ErrorCode::Timeout, "the scan ran out")),
    );
    let kinds: Vec<&str> = kept.iter().map(|entry| entry.kind.as_str()).collect();
    assert_eq!(kinds, ["window", "sheet"]);
    assert_eq!(kept[0].unclassified, ["menu"]);
    assert!(kept[1].unclassified.is_empty());
}

#[test]
fn a_nested_dialog_lists_one_sheet_entry_on_its_own_id_beside_its_windows_entries() {
    use crate::system::menu::nested_surface::Nested;
    use crate::system::menu::surface_scan::NestedScan;
    let scan = NestedScan {
        found: vec![Nested {
            window: 0,
            id: "w-1.7-dlg".to_owned(),
            title: Some("About".to_owned()),
        }],
        menus: Vec::new(),
        complete: true,
        unread: Vec::new(),
    };
    let entries = super::nested_entries(&scan);
    let [entry] = entries.as_slice() else {
        panic!("one entry")
    };
    assert_eq!(
        (entry.id.as_str(), entry.kind.as_str()),
        ("w-1.7-dlg", "sheet")
    );
    assert_eq!(entry.title.as_deref(), Some("About"));
    assert!(
        surfaces_of(&[window("w-1.7-win", "Editor", false)])
            .iter()
            .all(|surface| surface.id != entry.id)
    );
}

#[test]
fn a_window_whose_tree_was_not_read_in_full_names_the_sheet_kind_unclassified() {
    use crate::system::menu::surface_scan::NestedScan;
    let windows = [window("w-1", "A", false), window("w-2", "B", false)];
    let scan = NestedScan {
        found: Vec::new(),
        menus: Vec::new(),
        complete: false,
        unread: vec![1],
    };
    let mut surfaces = surfaces_of(&windows);
    super::mark_unread(&mut surfaces, &windows, &scan);
    assert!(surfaces[0].unclassified.is_empty());
    assert_eq!(surfaces[1].unclassified, ["sheet"]);
}
