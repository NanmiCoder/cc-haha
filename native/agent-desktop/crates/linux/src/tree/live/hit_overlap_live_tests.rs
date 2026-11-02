use agent_desktop_core::{Action, DeliverySemantics, Direction, ErrorCode};

use super::live_rig::deadline;
use super::physical_live_rig::{Kit, Scene};
use super::physical_live_scripts::QT_BUTTON;
use crate::tree::{AtspiElement, ObservedRead, WalkLimits, WalkedNode};

fn named(node: &WalkedNode<ObservedRead>, name: &str) -> Option<AtspiElement> {
    if node
        .payload
        .node
        .properties
        .name
        .present()
        .map(String::as_str)
        == Some(name)
    {
        return Some(node.payload.node.element.clone());
    }
    node.children.iter().find_map(|child| named(child, name))
}

fn target(scene: &Scene, name: &str) -> agent_desktop_core::NativeHandle {
    let walk = crate::tree::walk::walker::walk_tree(
        &scene.bus,
        &scene.frame,
        &WalkLimits::default(),
        deadline(10_000),
    )
    .unwrap();
    let mut element = named(&walk.root, name).expect("the native target exists");
    element.set_ancestry(crate::tree::element::ancestry::of_root(&scene.frame));
    element.into_native_handle()
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn overlapping_siblings_refuse_clicks_and_wheels_before_dispatch() {
    for (kit, source) in [(Kit::Gtk, GTK3_OVERLAY), (Kit::Qt, QT_OVERLAP)] {
        let scene = Scene::open(kit, source, 3);
        super::physical_live_tests::activate_scene(&scene);
        let handle = target(&scene, "Target");
        for action in [Action::Click, Action::Scroll(Direction::Down, 1)] {
            let error = scene.act(&handle, action).expect_err("overlap must refuse");
            assert_eq!(error.code, ErrorCode::ActionFailed, "{error:?}");
            assert_eq!(error.disposition, DeliverySemantics::not_delivered());
            assert_eq!(error.details.as_ref().unwrap()["reason"], "sibling_overlap");
            assert_eq!(
                error.details.as_ref().unwrap()["physical_delivery_started"],
                false
            );
        }
        if kit == Kit::Qt {
            let row = target(&scene, "Row 5");
            let error = scene
                .act(&row, Action::Click)
                .expect_err("ancestor overlap must refuse");
            assert_eq!(error.details.as_ref().unwrap()["reason"], "sibling_overlap");
        }
        assert_eq!(scene.log_text(), "", "refusal emitted an application event");
        std::fs::write(format!("{}.hide", scene.log), "").unwrap();
        let ready = scene.wait_log(|log| log == "uncovered\n");
        assert_eq!(ready, "uncovered\n");
        let handle = target(&scene, "Target");
        scene.act(&handle, Action::Click).expect("uncovered click");
        assert_eq!(
            scene.wait_log(|log| log.contains("Target click\n")),
            "uncovered\nTarget click\n"
        );
        scene
            .act(&handle, Action::Scroll(Direction::Down, 1))
            .expect("uncovered wheel");
        assert_eq!(
            scene.wait_log(|log| log.contains("Target wheel\n")),
            "uncovered\nTarget click\nTarget wheel\n"
        );
    }
}

#[test]
#[ignore = "drives real applications; run through scripts/private-session.sh --wm"]
fn ordinary_buttons_receive_headed_clicks_without_sibling_overlap() {
    for (kit, source) in [
        (Kit::Gtk, GTK3_BUTTON),
        (Kit::Gtk, GTK4_BUTTON),
        (Kit::Qt, QT_BUTTON),
    ] {
        let scene = Scene::open(kit, source, 2);
        super::physical_live_tests::activate_scene(&scene);
        let button = scene.find(&["button"], Some("Go"));
        scene
            .act(&button, Action::Click)
            .expect("ordinary button click");
        assert_eq!(scene.wait_log(|log| log == "clicked\n"), "clicked\n");
    }
}

const GTK3_OVERLAY: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib
log = os.environ["AD_LIVE_LOG"]
def note(text):
    with open(log, "a") as f: f.write(text + "\n")
w = Gtk.Window(title="Sibling overlap GTK3")
w.set_default_size(300, 200)
overlay = Gtk.Overlay()
w.add(overlay)
def box(name):
    b = Gtk.EventBox()
    b.get_accessible().set_name(name)
    b.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.SCROLL_MASK)
    b.connect("button-press-event", lambda *_: note(name + " click") or True)
    b.connect("scroll-event", lambda *_: note(name + " wheel") or True)
    return b
target = box("Target")
cover = box("Cover")
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

const QT_OVERLAP: &str = r#"
import os, sys
from PyQt6.QtWidgets import QApplication, QWidget, QListWidget, QPushButton
from PyQt6.QtCore import QTimer
log = os.environ["AD_LIVE_LOG"]
def note(text):
    with open(log, "a") as f: f.write(text + "\n")
class Target(QListWidget):
    def mousePressEvent(self, event):
        note("Target click")
        super().mousePressEvent(event)
    def wheelEvent(self, event):
        note("Target wheel")
        super().wheelEvent(event)
class Cover(QPushButton):
    def mousePressEvent(self, event):
        note("Cover click")
        super().mousePressEvent(event)
    def wheelEvent(self, event):
        note("Cover wheel")
        event.accept()
app = QApplication(sys.argv)
w = QWidget()
w.setWindowTitle("Sibling overlap Qt")
w.setGeometry(100, 100, 300, 200)
target = Target(w)
target.setAccessibleName("Target")
target.setGeometry(0, 0, 300, 200)
target.addItems(["Row " + str(i) for i in range(30)])
cover = Cover("Cover", w)
cover.setGeometry(0, 0, 300, 200)
def poll():
    if not os.path.exists(log + ".hide"): return
    cover.hide()
    note("uncovered")
    timer.stop()
timer = QTimer()
timer.timeout.connect(poll)
timer.start(30)
w.show()
app.exec()
"#;

const GTK3_BUTTON: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="Ordinary GTK3")
w.set_default_size(300, 120)
b = Gtk.Button(label="Go")
b.connect("clicked", lambda *_: open(os.environ["AD_LIVE_LOG"], "a").write("clicked\n"))
w.add(b)
w.show_all()
Gtk.main()
"#;

const GTK4_BUTTON: &str = r#"
import gi, os
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk
app = Gtk.Application(application_id="org.example.OrdinaryButton")
def activate(app):
    w = Gtk.ApplicationWindow(application=app, title="Ordinary GTK4")
    w.set_default_size(300, 120)
    b = Gtk.Button(label="Go")
    b.connect("clicked", lambda *_: open(os.environ["AD_LIVE_LOG"], "a").write("clicked\n"))
    w.set_child(b)
    w.present()
app.connect("activate", activate)
app.run(None)
"#;
