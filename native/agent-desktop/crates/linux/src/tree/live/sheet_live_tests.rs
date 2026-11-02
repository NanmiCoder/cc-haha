use std::time::Duration;

use agent_desktop_core::commands::find::{FindArgs, FindFilterArgs, FindSelectionArgs};
use agent_desktop_core::{
    Action, ActionOps, ActionRequest, CommandContext, ErrorCode, ObservationOps, RefEntry,
    RefStore, SnapshotSurface, TreeOptions, snapshot,
};

use super::live_rig::{deadline, wait_until};
use super::physical_live_rig::{Kit, Scene};
use crate::system::window::window_id;

pub(in crate::tree) const APP: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Atk, GLib
log = os.environ["AD_LIVE_LOG"]
w = Gtk.Window(title="Nested sheet")
w.set_default_size(420, 300)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
w.add(box)
outside = Gtk.Button(label="Save")
outside.connect("clicked", lambda *_: open(log, "a").write("outside\n"))
box.pack_start(outside, False, False, 0)
dialog = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
dialog.get_accessible().set_role(Atk.Role.DIALOG)
dialog.get_accessible().set_name("Sheet")
inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
inside = Gtk.Button(label="Save")
inside.connect("clicked", lambda *_: open(log, "a").write("sheet\n"))
inner.pack_start(inside, False, False, 0)
dialog.pack_start(inner, True, True, 0)
box.pack_start(dialog, True, True, 0)
def close():
    if os.path.exists(log + ".close"):
        box.remove(dialog)
        open(log + ".closed", "w").write("closed")
        return False
    return True
GLib.timeout_add(50, close)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

fn find_sheet(scene: &Scene, window: &str) -> RefEntry {
    let args = FindArgs {
        app: None,
        window_id: Some(window.to_owned()),
        root: None,
        surface: SnapshotSurface::Sheet,
        filter: FindFilterArgs {
            role: Some("button".to_owned()),
            name: Some("Save".to_owned()),
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: true,
        },
        states: Vec::new(),
        selection: FindSelectionArgs {
            first: true,
            last: false,
            count: false,
            nth: None,
            limit: None,
        },
        timeout_ms: Some(10_000),
    };
    let found = agent_desktop_core::commands::find::execute(
        args,
        &scene.adapter,
        &CommandContext::default(),
    )
    .expect("selected sheet match hydrates");
    let id = found["match"]["ref_id"].as_str().expect("a saved ref");
    RefStore::new().unwrap().load_ref(id).unwrap()
}

#[test]
#[ignore = "drives GTK; run through scripts/private-session.sh --wm"]
fn sheet_live_selected_find_and_snapshot_never_target_the_outside_twin() {
    let scene = Scene::open(Kit::Gtk, APP, 6);
    let window = window_id::encode(scene.frame.bus_name(), scene.frame.path()).unwrap();
    let selected = find_sheet(&scene, &window);
    let result = snapshot::build(
        &scene.adapter,
        &TreeOptions {
            surface: SnapshotSurface::Sheet,
            include_bounds: true,
            ..TreeOptions::default()
        },
        None,
        Some(&window),
        deadline(10_000),
    )
    .expect("a sheet snapshot");
    let map = serde_json::to_value(result.refmap).unwrap();
    let captured: RefEntry = map["inner"]
        .as_object()
        .unwrap()
        .values()
        .find(|entry| entry["role"] == "button" && entry["name"] == "Save")
        .map(|entry| serde_json::from_value(entry.clone()).unwrap())
        .expect("the sheet Save ref");
    for entry in [&selected, &captured] {
        let target = scene
            .adapter
            .resolve_element_strict(entry, deadline(5_000))
            .unwrap();
        let lease = scene.lease();
        scene
            .adapter
            .execute_action(&target, ActionRequest::headless(Action::Click), &lease)
            .expect("the sheet Save is clicked");
    }
    assert_eq!(
        scene.wait_log(|log| log.lines().count() >= 2),
        "sheet\nsheet\n"
    );
    std::fs::write(format!("{}.close", scene.log), "close").unwrap();
    assert!(wait_until(Duration::from_secs(5), || std::path::Path::new(
        &format!("{}.closed", scene.log)
    )
    .exists()));
    for entry in [&selected, &captured] {
        for outcome in [
            scene.adapter.resolve_element_strict(entry, deadline(5_000)),
            scene.adapter.resolve_locator_anchor(entry, deadline(5_000)),
        ] {
            assert_eq!(
                outcome
                    .err()
                    .expect("the outside twin cannot replace the sheet")
                    .code,
                ErrorCode::StaleRef
            );
        }
    }
    assert_eq!(scene.log_text(), "sheet\nsheet\n");
}
