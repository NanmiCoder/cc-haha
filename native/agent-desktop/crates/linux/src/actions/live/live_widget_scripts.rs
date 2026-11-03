pub(in crate::actions) const GTK3_WIDGETS: &str = r#"
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

window = Gtk.Window(title="adv-" + sys.argv[1])
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
status = Gtk.Entry()
status.get_accessible().set_name("status")
box.add(status)
button = Gtk.Button(label="Press me")
button.connect("clicked", lambda *_: status.set_text("clicked"))
box.add(button)
flag = Gtk.CheckButton(label="Flag")
flag.connect("toggled", lambda widget: status.set_text("flag:%s" % widget.get_active()))
box.add(flag)
combo = Gtk.ComboBoxText()
for item in ("alpha", "beta", "gamma"):
    combo.append_text(item)
combo.set_active(0)
combo.connect("changed", lambda widget: status.set_text("combo:%s" % widget.get_active_text()))
box.add(combo)
view = Gtk.TextView()
view.get_buffer().set_text("\U0001F600 brave world")
view.get_accessible().set_name("view")
box.add(view)
window.add(box)
window.show_all()
Gtk.main()
"#;

pub(in crate::actions) const GTK4_WIDGETS: &str = r#"
import sys
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk

def label(widget, text):
    widget.update_property([Gtk.AccessibleProperty.LABEL], [text])

def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="adv-" + sys.argv[1])
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    status = Gtk.Entry()
    label(status, "status")
    box.append(status)
    button = Gtk.Button(label="Press me")
    button.connect("clicked", lambda *_: status.set_text("clicked"))
    box.append(button)
    flag = Gtk.CheckButton(label="Flag")
    flag.connect("toggled", lambda widget: status.set_text("flag:%s" % widget.get_active()))
    box.append(flag)
    field = Gtk.Entry()
    field.set_text("\U0001F600 brave world")
    label(field, "field")
    box.append(field)
    window.set_child(box)
    window.present()

app = Gtk.Application(application_id="org.agentdesktop.WidgetFixture4")
app.connect("activate", activate)
app.run([])
"#;

pub(in crate::actions) const QT_WIDGETS: &str = r#"
import sys
from PyQt6.QtWidgets import (QApplication, QWidget, QVBoxLayout, QLineEdit, QPushButton, QCheckBox, QComboBox, QListWidget)
app = QApplication(sys.argv)
w = QWidget()
w.setWindowTitle("adv-" + sys.argv[1])
lay = QVBoxLayout(w)
status = QLineEdit()
status.setAccessibleName("status")
lay.addWidget(status)
button = QPushButton("Press me")
button.clicked.connect(lambda: status.setText("clicked"))
lay.addWidget(button)
flag = QCheckBox("Flag")
flag.toggled.connect(lambda on: status.setText("flag:%s" % on))
lay.addWidget(flag)
combo = QComboBox()
combo.addItems(["alpha", "beta", "gamma"])
combo.setAccessibleName("combo")
combo.currentTextChanged.connect(lambda text: status.setText("combo:%s" % text))
lay.addWidget(combo)
items = QListWidget()
items.addItems(["one", "two", "three"])
items.setAccessibleName("items")
items.itemSelectionChanged.connect(lambda: status.setText("list:%s" % ",".join(i.text() for i in items.selectedItems())))
lay.addWidget(items)
w.show()
sys.exit(app.exec())
"#;

pub(in crate::actions) const BROWSER_PAGE: &str = r#"<html><head><title>TAG</title></head><body>
<button id="bt" onclick="document.title='TAG:clicked'">Press</button>
<input type="checkbox" id="ck" onchange="document.title='TAG:chk=' + this.checked">
<label for="ck">Agree</label>
</body></html>"#;

pub(in crate::actions) const QT_PLAIN: &str = r#"
import sys
from PyQt6.QtWidgets import QApplication, QWidget, QVBoxLayout, QPushButton
app = QApplication(sys.argv)
w = QWidget()
w.setWindowTitle("plain-" + sys.argv[1])
QVBoxLayout(w).addWidget(QPushButton("b"))
w.show()
sys.exit(app.exec())
"#;

pub(in crate::actions) const QT_MAIN: &str = r#"
import sys
from PyQt6.QtWidgets import QApplication, QMainWindow, QWidget, QVBoxLayout, QPushButton
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("main-" + sys.argv[1])
c = QWidget()
QVBoxLayout(c).addWidget(QPushButton("b"))
w.setCentralWidget(c)
w.show()
sys.exit(app.exec())
"#;
