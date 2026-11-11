use agent_desktop_core::{AdapterError, Deadline};

use crate::system::{SharedBus, within};
use crate::tree::properties::node_read::call;
use crate::tree::{AtspiElement, COMPONENT_INTERFACE, Extents};

pub(in crate::tree) const GTK3_STRIP: &str = r#"
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="adscroll-gtk3-strip")
w.set_default_size(480, 200)
s = Gtk.ScrolledWindow()
s.set_policy(Gtk.PolicyType.ALWAYS, Gtk.PolicyType.NEVER)
b = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
for i in range(300):
    b.pack_start(Gtk.Button(label="Col %03d" % i), False, False, 0)
s.add(b)
w.add(s)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

pub(in crate::tree) const GTK4_STRIP: &str = r#"
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk
def activate(app):
    w = Gtk.ApplicationWindow(application=app, title="adscroll-gtk4-strip")
    w.set_default_size(480, 200)
    s = Gtk.ScrolledWindow()
    s.set_policy(Gtk.PolicyType.ALWAYS, Gtk.PolicyType.NEVER)
    b = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
    for i in range(300):
        b.append(Gtk.Button(label="Col %03d" % i))
    s.set_child(b)
    w.set_child(s)
    w.present()
app = Gtk.Application(application_id="org.agentdesktop.ScrollStrip4")
app.connect("activate", activate)
app.run([])
"#;

pub(in crate::tree) const QT_LIST: &str = r#"
import sys, os, json
from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication, QMainWindow, QListWidget
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adscroll-qt")
lw = QListWidget()
lw.addItems(["Item %03d" % i for i in range(300)])
w.setCentralWidget(lw)
w.setGeometry(100, 100, 480, 360)
def record_scroll():
    path = os.environ.get("AD_LIVE_LOG")
    if path:
        with open(path, "w") as output:
            json.dump({"offset": lw.verticalScrollBar().value(),
                       "visible": lw.visualItemRect(lw.item(40)).intersects(lw.viewport().rect())}, output)
lw.verticalScrollBar().valueChanged.connect(record_scroll)
w.show()
QTimer.singleShot(0, record_scroll)
sys.exit(app.exec())
"#;

pub(in crate::tree) fn window_rect(bus: &SharedBus, element: &AtspiElement) -> Option<Extents> {
    let deadline = Deadline::after(3_000).ok()?;
    let connection = bus.get(deadline).ok()?;
    let (x, y, width, height) = within(deadline, async {
        let reply = call(
            connection.inner(),
            element,
            COMPONENT_INTERFACE,
            "GetExtents",
            &(1u32,),
        )
        .await
        .map_err(|error| AdapterError::internal(error.to_string()))?;
        reply
            .body()
            .deserialize::<(i32, i32, i32, i32)>()
            .map_err(|error| AdapterError::internal(error.to_string()))
    })
    .ok()?;
    Some(Extents {
        x,
        y,
        width,
        height,
    })
}

pub(in crate::tree) fn positive(rect: Option<Extents>) -> Option<Extents> {
    rect.filter(|r| r.width > 0 && r.height > 0 && r.x != i32::MIN && r.y != i32::MIN)
}

/// Whether the rectangle intersects the frame at all, `None` when either is
/// unusable. Written separately from the product rule on purpose.
pub(in crate::tree) fn intersects(node: Option<Extents>, frame: Option<Extents>) -> Option<bool> {
    let (n, f) = (positive(node)?, positive(frame)?);
    let across = n.x < f.x + f.width && f.x < n.x + n.width;
    let down = n.y < f.y + f.height && f.y < n.y + n.height;
    Some(across && down)
}

pub(in crate::tree) fn pointer() -> Option<(i16, i16)> {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::ConnectionExt;
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots[screen].root;
    let reply = connection.query_pointer(root).ok()?.reply().ok()?;
    Some((reply.root_x, reply.root_y))
}
