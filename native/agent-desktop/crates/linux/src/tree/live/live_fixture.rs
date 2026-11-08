use std::io::Write;
use std::path::PathBuf;

use super::live_launch::{Launched, nonce};

const GTK4_SCRIPT: &str = r#"
import sys
import gi
gi.require_version("Gtk", "4.0")
from gi.repository import Gtk, GLib

commands = sys.argv[2]
parts = {}

def run(words):
    name = words[0]
    if name == "page":
        parts["notebook"].set_current_page(int(words[1]))
    elif name == "remove":
        parts["outer"].remove(parts["victim"])
    elif name == "close":
        parts["window"].close()

def poll():
    try:
        text = open(commands).read().strip()
    except OSError:
        return True
    if text:
        open(commands, "w").close()
        for line in text.splitlines():
            run(line.split())
    return True

def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="adg4-" + sys.argv[1])
    outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    notebook = Gtk.Notebook()
    for name in ("PageA", "PageB"):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(Gtk.Button(label="Button" + name))
        notebook.append_page(box, Gtk.Label(label=name))
    outer.append(notebook)
    victim = Gtk.Button(label="Victim")
    outer.append(victim)
    twins = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
    for width in (80, 140):
        twin = Gtk.Button(label="Twin")
        twin.set_size_request(width, -1)
        twins.append(twin)
    outer.append(twins)
    hidden = Gtk.Entry()
    hidden.set_visibility(False)
    hidden.set_text("hunter2")
    outer.append(hidden)
    peek = Gtk.PasswordEntry()
    peek.set_text("hunter2")
    outer.append(peek)
    plain = Gtk.Entry()
    plain.set_text("plain-text")
    outer.append(plain)
    window.set_child(outer)
    parts.update(window=window, outer=outer, notebook=notebook, victim=victim)
    GLib.timeout_add(100, poll)
    window.present()

app = Gtk.Application(application_id="org.agentdesktop.Fixture4")
app.connect("activate", activate)
app.run([])
"#;

const GTK3_SCRIPT: &str = r#"
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

commands = sys.argv[2]
parts = {}

def run(words):
    name = words[0]
    if name == "remove":
        parts["victim"].destroy()
    elif name == "close":
        parts["window"].destroy()

def poll():
    try:
        text = open(commands).read().strip()
    except OSError:
        return True
    if text:
        open(commands, "w").close()
        for line in text.splitlines():
            run(line.split())
    return True

window = Gtk.Window(title="adg3-" + sys.argv[1])
outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
victim = Gtk.Button(label="Victim")
outer.pack_start(victim, False, False, 0)
outer.pack_start(Gtk.Button(label="Stays"), False, False, 0)
hidden = Gtk.Entry()
hidden.set_visibility(False)
hidden.set_text("hunter2")
outer.pack_start(hidden, False, False, 0)
plain = Gtk.Entry()
plain.set_text("plain-text")
outer.pack_start(plain, False, False, 0)
window.add(outer)
parts.update(window=window, victim=victim)
window.connect("destroy", Gtk.main_quit)
GLib.timeout_add(100, poll)
window.show_all()
Gtk.main()
"#;

const QT_SCRIPT: &str = r#"
import sys
from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
                             QPushButton, QLineEdit, QListWidget)
commands = sys.argv[2]
app = QApplication(sys.argv)
window = QMainWindow()
window.setWindowTitle("adq-" + sys.argv[1])
central = QWidget()
column = QVBoxLayout(central)
twins = QHBoxLayout()
for width in (80, 140):
    twin = QPushButton("Twin")
    twin.setFixedWidth(width)
    twins.addWidget(twin)
column.addLayout(twins)
victim = QPushButton("Victim")
column.addWidget(victim)
secret = QLineEdit()
secret.setEchoMode(QLineEdit.EchoMode.Password)
secret.setText("hunter2")
column.addWidget(secret)
plain = QLineEdit()
plain.setText("plain-text")
column.addWidget(plain)
rows = QListWidget()
rows.addItems(["alpha", "beta", "gamma"])
column.addWidget(rows)
window.setCentralWidget(central)
window.setGeometry(100, 100, 480, 360)

def run(words):
    name = words[0]
    if name == "move":
        window.move(int(words[1]), int(words[2]))
    elif name == "remove":
        victim.deleteLater()
    elif name == "reverse":
        rows.clear()
        rows.addItems(["gamma", "beta", "alpha"])
    elif name == "close":
        window.close()

def poll():
    try:
        text = open(commands).read().strip()
    except OSError:
        return
    if text:
        open(commands, "w").close()
        for line in text.splitlines():
            run(line.split())

timer = QTimer()
timer.timeout.connect(poll)
timer.start(100)
window.show()
sys.exit(app.exec())
"#;

/// A scripted application whose interface changes when a line is appended to
/// its command file.
pub(in crate::tree) struct Fixture {
    pub(in crate::tree) pid: u32,
    commands: PathBuf,
}

impl Fixture {
    pub(in crate::tree) fn send(&self, line: &str) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.commands)
            .expect("the command file opens");
        writeln!(file, "{line}").expect("the command is written");
    }
}

fn scripted(
    launched: &mut Launched,
    program: &str,
    source: &str,
    env: &[(&str, String)],
) -> Result<Fixture, String> {
    let dir = std::env::temp_dir().join(nonce("fixture"));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    launched.scratch.push(dir.clone());
    let script = dir.join("app.py");
    std::fs::write(&script, source).map_err(|error| error.to_string())?;
    let commands = dir.join("commands");
    std::fs::write(&commands, "").map_err(|error| error.to_string())?;
    let script_arg = script.to_string_lossy().into_owned();
    let commands_arg = commands.to_string_lossy().into_owned();
    let pid = launched.try_spawn_with_env(program, &[&script_arg, "live", &commands_arg], env)?;
    Ok(Fixture { pid, commands })
}

pub(in crate::tree) fn gtk4(launched: &mut Launched) -> Result<Fixture, String> {
    scripted(launched, "python3", GTK4_SCRIPT, &[])
}

pub(in crate::tree) fn gtk3(launched: &mut Launched) -> Result<Fixture, String> {
    scripted(launched, "python3", GTK3_SCRIPT, &[])
}

pub(in crate::tree) fn qt(launched: &mut Launched) -> Result<Fixture, String> {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

    scripted(
        launched,
        &python,
        QT_SCRIPT,
        &[
            ("QT_ACCESSIBILITY", "1".to_owned()),
            ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
            ("QT_QPA_PLATFORM", "xcb".to_owned()),
        ],
    )
}
