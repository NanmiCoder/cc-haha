use super::live_launch::{Launched, nonce};

const QT_SCRIPT: &str = r#"
import sys
from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout, QPushButton,
                             QLineEdit, QLabel, QCheckBox, QComboBox, QListWidget)
app = QApplication(sys.argv)
w = QMainWindow()
w.setWindowTitle("adq-" + sys.argv[1])
c = QWidget()
lay = QVBoxLayout(c)
b = QPushButton("Press")
b.setObjectName("okButton")
lay.addWidget(b)
e = QLineEdit()
e.setPlaceholderText("Type name")
lay.addWidget(e)
lay.addWidget(QLabel("Name:"))
lay.addWidget(QCheckBox("Option"))
combo = QComboBox()
combo.addItems(["one", "two"])
lay.addWidget(combo)
lw = QListWidget()
lw.addItems(["a", "b", "c"])
lay.addWidget(lw)
m = w.menuBar().addMenu("File")
m.addAction("Open")
w.setCentralWidget(c)
w.show()
sys.exit(app.exec())
"#;

pub(in crate::tree) const BUTTON_LABEL: &str = "Press";

/// Starts a small Qt 6 window with accessibility forced on and returns its
/// process id.
pub(in crate::tree) fn launch(launched: &mut Launched) -> Result<u32, String> {
    launch_script(launched, QT_SCRIPT)
}

fn launch_script(launched: &mut Launched, source: &str) -> Result<u32, String> {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());
    let dir = std::env::temp_dir().join(nonce("qt"));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    launched.scratch.push(dir.clone());
    let script = dir.join("app.py");
    std::fs::write(&script, source).map_err(|error| error.to_string())?;

    let script_arg = script.to_string_lossy().into_owned();
    launched.try_spawn_with_env(
        &python,
        &[&script_arg, "live"],
        &[
            ("QT_ACCESSIBILITY", "1".to_owned()),
            ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
            ("QT_QPA_PLATFORM", "xcb".to_owned()),
        ],
    )
}
