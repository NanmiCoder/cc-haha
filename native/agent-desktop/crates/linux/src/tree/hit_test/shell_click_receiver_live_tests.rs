use agent_desktop_core::{DeliverySemantics, ErrorCode, InteractionPolicy, MouseButton};

use crate::input::physical::target_pointer::click_shell as click;
use crate::tree::live::physical_live_rig::{Kit, Scene};
use crate::tree::live::physical_live_tests::activate_scene;

#[test]
#[ignore = "drives GTK3 and Qt in scripts/private-session.sh --wm"]
fn shell_click_requires_the_shared_sibling_proof_before_dispatch() {
    for (kit, source) in [(Kit::Gtk, GTK), (Kit::Qt, QT)] {
        let scene = Scene::open(kit, source, 3);
        activate_scene(&scene);
        let handle = scene.find(&["button"], Some("Target"));
        let target = crate::tree::atspi_element(&handle).unwrap();
        let invoke = || {
            click(
                &scene.bus,
                target,
                MouseButton::Left,
                InteractionPolicy::headed(),
                &scene.lease(),
            )
        };
        let error = invoke().expect_err("overlapping sibling cannot authorize shell delivery");
        assert_eq!(error.code, ErrorCode::ActionFailed, "{error:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.as_ref().unwrap()["reason"], "sibling_overlap");
        assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
        assert_eq!(
            scene.log_text(),
            "",
            "refusal must emit no application event"
        );
        std::fs::write(format!("{}.hide", scene.log), "").unwrap();
        assert_eq!(scene.wait_log(|log| log == "uncovered\n"), "uncovered\n");
        invoke().expect("the same target without overlap receives the click");
        assert_eq!(
            scene.wait_log(|log| log.contains("Target\n")),
            "uncovered\nTarget\n"
        );
        eprintln!("independent application receipt: {}", scene.log_text());
    }
}

const GTK: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
log = os.environ["AD_LIVE_LOG"]
def note(text):
    with open(log, "a") as f: f.write(text + "\n")
w = Gtk.Window(title="Receiver proof")
w.set_default_size(320, 200)
overlay = Gtk.Overlay()
w.add(overlay)
target = Gtk.Button(label="Target")
cover = Gtk.Button(label="Cover")
target.connect("clicked", lambda *_: note("Target"))
cover.connect("clicked", lambda *_: note("Cover"))
overlay.add(target)
overlay.add_overlay(cover)
def poll():
    if not os.path.exists(log + ".hide"): return True
    cover.hide()
    note("uncovered")
    return False
GLib.timeout_add(30, poll)
w.show_all()
Gtk.main()
"#;

const QT: &str = r#"
import os, sys
from PyQt6.QtWidgets import QApplication, QWidget, QPushButton
from PyQt6.QtCore import QTimer
log = os.environ["AD_LIVE_LOG"]
def note(text):
    with open(log, "a") as f: f.write(text + "\n")
app = QApplication(sys.argv)
w = QWidget()
w.setWindowTitle("Receiver proof")
w.resize(320, 200)
target = QPushButton("Target", w)
target.setGeometry(0, 0, 320, 200)
cover = QPushButton("Cover", w)
cover.setGeometry(0, 0, 320, 200)
target.clicked.connect(lambda: note("Target"))
cover.clicked.connect(lambda: note("Cover"))
def poll():
    if os.path.exists(log + ".hide"):
        cover.hide()
        note("uncovered")
        timer.stop()
timer = QTimer()
timer.timeout.connect(poll)
timer.start(30)
w.show()
app.exec()
"#;
