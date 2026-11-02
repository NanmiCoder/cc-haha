use std::time::Duration;

use super::{
    MENU_BUTTON, MENU_ITEM, Node, Rig, TOGGLE, app_inventory, deadline, descendants, do_action,
    poll, press, top_level, within,
};
use crate::tree::live::live_launch::nonce;

const QT_SCRIPT: &str = r#"
import os, sys, time
from PyQt6.QtCore import QTimer
from PyQt6.QtWidgets import QApplication, QMainWindow, QLabel
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adq-" + sys.argv[1])
w.setCentralWidget(QLabel("signal"))
m = w.menuBar().addMenu("File")
m.addAction("Open")
w.show()
flag = sys.argv[2]
def check():
    if os.path.exists(flag):
        time.sleep(60)
timer = QTimer()
timer.timeout.connect(check)
timer.start(20)
sys.exit(app.exec())
"#;

pub(crate) fn main_menu_toggle(rig: &Rig, pid: u32) -> Node {
    poll("the main menu toggle", || {
        let tree = descendants(&rig.connection, pid);
        let named = tree
            .iter()
            .position(|n| n.role == TOGGLE && n.name == "Main Menu");
        let button = tree
            .iter()
            .position(|n| n.role == MENU_BUTTON && n.name == "Main Menu");
        let at = named.or(button)?;
        tree.into_iter().skip(at).find(|n| n.role == TOGGLE)
    })
}

pub(crate) fn open_gtk4_menu_item(rig: &Rig, pid: u32, from_end: usize) {
    do_action(&rig.connection, &main_menu_toggle(rig, pid));
    std::thread::sleep(Duration::from_millis(1_200));
    let mut last = 0;
    let items = poll("the popover items", || {
        let items: Vec<Node> = descendants(&rig.connection, pid)
            .into_iter()
            .filter(|n| n.role == MENU_ITEM)
            .collect();
        let settled = !items.is_empty() && items.len() == last;
        last = items.len();
        settled.then_some(items)
    });
    let target = items
        .into_iter()
        .rev()
        .nth(from_end - 1)
        .expect("the popover has enough items");
    do_action(&rig.connection, &target);
}

pub(crate) fn terminal_server(rig: &mut Rig) -> u32 {
    rig.spawn("gnome-terminal", &[]);
    let pid = poll("the terminal server window", || {
        let apps = app_inventory(rig.bus(), deadline(10_000)).ok()?.apps;
        apps.into_iter()
            .find(|app| app.name == "gnome-terminal-server")
            .map(|app| u32::from(app.pid))
    });
    rig.adopt(pid)
}

pub(crate) fn launch_qt(rig: &mut Rig, flag: &str) -> u32 {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());
    let dir = std::env::temp_dir().join(nonce("l311d-qt"));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    rig.launched.scratch.push(dir.clone());
    let script = dir.join("app.py");
    std::fs::write(&script, QT_SCRIPT).expect("script");

    let script_arg = script.to_string_lossy().into_owned();
    rig.launched.spawn_with_env(
        &python,
        &[&script_arg, "live", flag],
        &[
            ("QT_ACCESSIBILITY", "1".to_owned()),
            ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
            ("QT_QPA_PLATFORM", "xcb".to_owned()),
        ],
    )
}

pub(crate) fn dismiss_dialog(rig: &Rig, app: &str, pid: u32, before: usize) {
    poll("the dialog to close", || {
        let top = top_level(&rig.connection, pid);
        if top.len() == before {
            return Some(());
        }
        let _ = press(rig, app, "escape");
        std::thread::sleep(Duration::from_millis(500));
        let dialog = top.last()?;
        let close = within(&rig.connection, dialog)
            .into_iter()
            .find(|n| n.name == "Close" && n.role == MENU_BUTTON)?;
        if top_level(&rig.connection, pid).len() > before {
            do_action(&rig.connection, &close);
        }
        std::thread::sleep(Duration::from_millis(500));
        None
    });
}

pub(crate) fn scratch_dir(rig: &mut Rig, label: &str) -> String {
    let dir = std::env::temp_dir().join(nonce(label));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    rig.launched.scratch.push(dir.clone());
    dir.to_string_lossy().into_owned()
}
