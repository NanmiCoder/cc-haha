use agent_desktop_core::{SnapshotSurface, WindowInfo, WindowState};

use super::sheet_signals;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::system::x11::FrameFacts;
use crate::tree::AtspiElement;

fn app() -> RegistryApp {
    assemble(
        AtspiElement::new(":1.4", "/org/a11y/atspi/accessible/root", 77),
        ProcessFacts {
            executable: None,
            comm: "calc".to_owned(),
            exe_basename: Some("calc".to_owned()),
            instance: "boot:77".to_owned(),
        },
        Some(Some("Calculator".to_owned())),
        ToolkitId::default(),
    )
}

fn window(id: &str, title: &str, sheet: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: id.to_owned(),
            title: title.to_owned(),
            app: "calc".to_owned(),
            pid: 77.into(),
            process_instance: Some("boot:77".to_owned()),
            bounds: None,
            state: WindowState {
                is_focused: false,
                accessible: true,
                minimized: None,
                visible: Some(true),
            },
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 77,
            title: title.to_owned(),
            extents: None,
            global_position: false,
        },
        sheet,
        unshown: false,
    }
}

#[test]
fn only_sheet_windows_become_signals_and_each_carries_its_identity() {
    let windows = [
        window("w-1", "Calculator", false),
        window("w-2", "About", true),
    ];
    let signals = sheet_signals(&windows, &[app()]);
    let [signal] = signals.as_slice() else {
        panic!("one signal")
    };
    assert_eq!(signal.kind, SnapshotSurface::Sheet);
    assert_eq!(signal.id, "w-2");
    assert_eq!(signal.title.as_deref(), Some("About"));
    assert_eq!(signal.app, "calc");
    assert_eq!(signal.pid.get(), 77);
    assert_eq!(signal.process_instance, "boot:77");
}

#[test]
fn a_dialog_without_a_name_is_keyed_on_its_id() {
    let signals = sheet_signals(&[window("w-3", "", true)], &[app()]);
    assert_eq!(signals.len(), 1);
    assert_eq!(signals[0].id, "w-3");
    assert_eq!(signals[0].title, None);
}

#[test]
fn a_window_naming_a_missing_registry_entry_gives_no_signal() {
    assert!(sheet_signals(&[window("w-2", "About", true)], &[]).is_empty());
}

fn nested(id: &str, title: Option<&str>) -> crate::system::menu::nested_surface::Nested {
    crate::system::menu::nested_surface::Nested {
        window: 0,
        id: id.to_owned(),
        title: title.map(str::to_owned),
    }
}

fn scan(
    found: Vec<crate::system::menu::nested_surface::Nested>,
) -> crate::system::menu::surface_scan::NestedScan {
    crate::system::menu::surface_scan::NestedScan {
        found,
        menus: Vec::new(),
        complete: true,
        unread: Vec::new(),
    }
}

#[test]
fn a_dialog_inside_a_window_is_one_sheet_signal_on_its_own_id() {
    let windows = [window("w-1.4-win", "Editor", false)];
    let signals = super::nested_surface_signals(
        &scan(vec![nested("w-1.4-dlg", Some("About"))]),
        &windows,
        &[app()],
    );
    let [signal] = signals.as_slice() else {
        panic!("one signal")
    };
    assert_eq!(signal.id, "w-1.4-dlg");
    assert_eq!(signal.kind, SnapshotSurface::Sheet);
    assert_eq!(signal.pid.get(), 77);
    assert_eq!(signal.title.as_deref(), Some("About"));
}

#[test]
fn a_menu_maps_its_own_identity() {
    let windows = [window("w-1.4-win", "Editor", false)];
    let scan = |menus| crate::system::menu::surface_scan::NestedScan {
        found: Vec::new(),
        menus,
        complete: true,
        unread: Vec::new(),
    };
    let open =
        super::nested_surface_signals(&scan(vec![nested("w-1.4-menu", None)]), &windows, &[app()]);
    let [signal] = open.as_slice() else {
        panic!("one menu signal")
    };
    assert_eq!(signal.kind, SnapshotSurface::Menu);
    assert_eq!(signal.id, "w-1.4-menu");
    assert_eq!(signal.pid.get(), 77);
}
