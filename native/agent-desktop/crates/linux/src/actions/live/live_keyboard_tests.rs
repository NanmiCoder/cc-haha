use std::path::Path;

use agent_desktop_core::{
    Action, ActionRequest, Deadline, DeliverySemantics, ObservationOps, SystemOps, WindowFilter,
};

use super::live_bench::Bench;
use crate::tree::live::live_launch::{Launched, nonce};

const APP: &str = r#"
import json, pathlib, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title=sys.argv[1])
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
entry.get_accessible().set_name("Sibling")
entry.set_text("unchanged")
box.add(entry)
empty = Gtk.Entry()
empty.get_accessible().set_name("Empty")
box.add(empty)
clicks = 0
def record(*_):
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"entry": entry.get_text(), "empty": empty.get_text(), "clicks": clicks, "sibling_focused": entry.has_focus()}))
    temporary.replace(path)
def clicked(*_):
    global clicks
    clicks += 1
    record()
for label, focusable in [("Unfocusable", False), ("Target", True)]:
    button = Gtk.Button(label=label)
    button.set_can_focus(focusable)
    button.connect("clicked", clicked)
    box.add(button)
entry.connect("changed", record)
entry.connect("focus-in-event", record)
entry.connect("focus-out-event", record)
empty.connect("changed", record)
window.add(box)
window.show_all()
entry.grab_focus()
record()
Gtk.main()
"#;

fn read(path: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(path).expect("app's state file"))
        .expect("app state")
}

fn open() -> (Bench, std::path::PathBuf) {
    let mut launched = Launched::new();
    let tag = nonce("keyboard");
    let scratch = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&scratch).expect("scratch");
    launched.scratch.push(scratch.clone());
    let state = scratch.join("state.json");
    let pid = launched.spawn("python3", &["-c", APP, &tag, state.to_str().expect("path")]);
    let adapter = crate::LinuxAdapter::new();
    let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
    let bench = Bench::attach(launched, frame);
    let window = bench
        .wait_for(|| {
            bench
                .adapter()
                .list_windows(&WindowFilter::default(), Deadline::after(3_000).unwrap())
                .unwrap()
                .into_iter()
                .find(|window| window.pid.get() == pid && window.state.visible == Some(true))
        })
        .expect("the fixture is mapped");
    let lease = bench
        .adapter()
        .acquire_interaction_lease(Deadline::after(8_000).unwrap())
        .unwrap();
    bench.adapter().focus_window(&window, &lease).unwrap();
    let sibling = bench.named("Sibling");
    crate::input::physical::keyboard_focus::grab(
        bench.adapter().bus(),
        crate::tree::atspi_element(&sibling).unwrap(),
        lease.deadline(),
    )
    .unwrap();
    assert!(
        bench
            .wait_for(|| (read(&state)["sibling_focused"] == true).then_some(()))
            .is_some()
    );
    (bench, state)
}

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn focus_transport_timeouts_survive_and_a_responsive_target_still_focuses() {
    use agent_desktop_core::ErrorCode;
    let (bench, state) = open();
    let target = bench.named("Target");
    let element = crate::tree::atspi_element(&target).unwrap();
    let pid = bench.frame().pid();
    let before = read(&state);
    assert!(
        std::process::Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    let paused = super::live_scroll_tests::Paused(pid);
    assert!(
        bench
            .wait_for(|| crate::system::process::proc_stat::is_stopped(pid).then_some(()))
            .is_some()
    );
    let bus = bench.adapter().bus();
    let read_error =
        crate::input::physical::keyboard_focus::read(bus, element, Deadline::after(150).unwrap())
            .unwrap_err();
    let grab_error =
        crate::input::physical::keyboard_focus::grab(bus, element, Deadline::after(150).unwrap())
            .unwrap_err();
    for error in [read_error, grab_error] {
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(error.details.is_some(), "deadline evidence survives");
    }
    assert_eq!(read(&state), before, "no keyboard input was sent");
    drop(paused);
    crate::input::physical::keyboard_focus::grab(bus, element, Deadline::after(3000).unwrap())
        .unwrap();
    assert!(
        bench
            .wait_for(|| crate::input::physical::keyboard_focus::read(
                bus,
                element,
                Deadline::after(3000).unwrap()
            )
            .unwrap()
            .then_some(()))
            .is_some()
    );
    assert_eq!(read(&state)["clicks"], 0);
    assert_eq!(read(&state)["entry"], "unchanged");
}

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn empty_ref_typing_preserves_focus_and_content_without_claiming_delivery() {
    let (bench, state) = open();
    let empty = bench.named("Empty");
    let before = read(&state);
    let result = bench
        .act_with(
            &empty,
            ActionRequest::headed(Action::TypeText(String::new())),
        )
        .expect("empty insertion is satisfied");
    assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
    assert_eq!(read(&state), before, "no focus or text changed");
    let blocked = bench.named("Unfocusable");
    let error = bench
        .act_with(
            &blocked,
            ActionRequest::headed(Action::TypeText("x".to_owned())),
        )
        .expect_err("nonempty input still requires target focus");
    assert_eq!(error.details.expect("details")["check"], "target_focus");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(read(&state), before);
    bench
        .act_with(
            &empty,
            ActionRequest::headed(Action::TypeText("x".to_owned())),
        )
        .expect("nonempty input reaches its target");
    assert!(
        bench
            .wait_for(|| (read(&state)["empty"] == "x").then_some(()))
            .is_some()
    );
    assert_eq!(read(&state)["entry"], "unchanged");
}
