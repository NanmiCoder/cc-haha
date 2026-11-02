pub(in crate::tree) const QT_BUTTON: &str = r#"
import os, sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QPushButton
log = os.environ["AD_LIVE_LOG"]
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adbtn")
b = QPushButton("Go")
b.clicked.connect(lambda: open(log, "a").write("clicked\n"))
w.setCentralWidget(b)
w.resize(320, 120)
w.show()
sys.exit(app.exec())
"#;

pub(in crate::tree) const QT_ENTRY: &str = r#"
import os, sys
from PyQt6.QtWidgets import QApplication, QLineEdit, QMainWindow
log = os.environ["AD_LIVE_LOG"]
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adx")
e = QLineEdit()
e.textChanged.connect(lambda t: open(log, "w").write(t))
w.setCentralWidget(e)
w.resize(320, 80)
w.show()
sys.exit(app.exec())
"#;

pub(in crate::tree) const GTK3_DRAG: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk
log = os.environ["AD_LIVE_LOG"]
def note(text):
    open(log, "a").write(text + "\n")
w = Gtk.Window(title="addrag")
w.set_default_size(600, 400)
box = Gtk.EventBox()
box.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK
               | Gdk.EventMask.BUTTON1_MOTION_MASK)
box.connect("button-press-event", lambda a, e: note("press %d %d" % (e.x_root, e.y_root)))
box.connect("button-release-event", lambda a, e: note("release %d %d" % (e.x_root, e.y_root)))
box.connect("motion-notify-event", lambda a, e: note("move"))
w.add(box)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"#;

pub(in crate::tree) const GTK3_GRAB: &str = r#"
import gi, os
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
log = os.environ["AD_LIVE_LOG"]
w = Gtk.Window(title="adgrab")
w.set_default_size(200, 100)
menu = Gtk.Menu()
for label in ("One", "Two"):
    menu.append(Gtk.MenuItem(label=label))
menu.show_all()
menu.connect("key-press-event", lambda a, e: open(log, "a").write("menukey\n"))
w.connect("destroy", Gtk.main_quit)
w.show_all()
popup_started = False
def popup_when_requested():
    global popup_started
    if not os.path.exists(os.environ["AD_LIVE_GRAB"]):
        return True
    if not popup_started:
        menu.popup(None, None, None, None, 0, Gtk.get_current_event_time())
        popup_started = True
    if not menu.get_mapped():
        return True
    open(os.environ["AD_LIVE_GRAB_READY"], "w").write("ready")
    return False
GLib.timeout_add(50, popup_when_requested)
Gtk.main()
"#;
