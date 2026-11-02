use agent_desktop_core::{AppPresentation, WindowInfo, WindowState};

use super::apps_of;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::listed_window::ListedWindow;
use crate::system::registry::registry_app::{RegistryApp, assemble};
use crate::system::x11::FrameFacts;
use crate::tree::AtspiElement;

fn app(bus: &str, pid: u32, instance: &str, name: &str) -> RegistryApp {
    assemble(
        AtspiElement::new(bus, "/org/a11y/atspi/accessible/root", pid),
        ProcessFacts {
            executable: None,
            comm: name.to_owned(),
            exe_basename: Some(name.to_owned()),
            instance: instance.to_owned(),
        },
        Some(Some(name.to_owned())),
        ToolkitId::default(),
    )
}

fn window(owner: usize, id: &str, visible: bool) -> ListedWindow {
    ListedWindow {
        app: owner,
        info: WindowInfo {
            id: id.to_owned(),
            title: String::new(),
            app: String::new(),
            pid: 1.into(),
            process_instance: None,
            bounds: None,
            state: WindowState {
                is_focused: false,
                accessible: true,
                minimized: None,
                visible: Some(visible),
            },
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 1,
            title: String::new(),
            extents: None,
            global_position: false,
        },
        sheet: false,
        unshown: false,
    }
}

#[test]
fn an_app_with_no_window_is_absent() {
    let apps = [
        app(":1.1", 10, "boot:1", "calc"),
        app(":1.2", 20, "boot:2", "gsd-media-keys"),
    ];
    let population = apps_of(&[window(0, "w-1", true)], &apps);
    let names: Vec<&str> = population.iter().map(|app| app.name.as_str()).collect();
    assert_eq!(names, ["calc"]);
}

#[test]
fn an_app_whose_only_window_is_hidden_is_present() {
    let apps = [app(":1.1", 10, "boot:1", "calc")];
    let population = apps_of(&[window(0, "w-1", false)], &apps);
    assert_eq!(population.len(), 1);
    assert_eq!(
        population[0].presentation,
        Some(AppPresentation::Foreground)
    );
    assert_eq!(population[0].process_instance.as_deref(), Some("boot:1"));
}

#[test]
fn a_qt_process_with_two_registry_entries_is_one_app() {
    let apps = [
        app(":1.7", 30, "boot:3", "qtapp"),
        app(":1.8", 30, "boot:3", "qtapp"),
    ];
    let one_owner = apps_of(&[window(1, "w-1", true)], &apps);
    assert_eq!(one_owner.len(), 1);
    let both_owners = apps_of(&[window(0, "w-1", true), window(1, "w-2", true)], &apps);
    assert_eq!(both_owners.len(), 1);
}

#[test]
fn a_restarted_process_is_a_different_app() {
    let apps = [
        app(":1.1", 10, "boot:1", "calc"),
        app(":1.9", 10, "boot:9", "calc"),
    ];
    let population = apps_of(&[window(0, "w-1", true), window(1, "w-2", true)], &apps);
    assert_eq!(population.len(), 2);
}

#[test]
fn a_window_naming_a_missing_registry_entry_is_ignored() {
    assert!(apps_of(&[window(4, "w-1", true)], &[]).is_empty());
}
