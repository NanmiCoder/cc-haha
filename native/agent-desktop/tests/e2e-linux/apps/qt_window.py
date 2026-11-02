from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def main(argv: list[str]) -> int:
    from PyQt6.QtCore import QTimer
    from PyQt6.QtWidgets import QApplication, QComboBox, QLineEdit, QMainWindow, QPushButton, QVBoxLayout, QWidget
    if len(argv) != 1:
        raise ValueError("expected the activation log path")
    log = Path(argv[0])
    app = QApplication([sys.argv[0]])
    window = QMainWindow()
    window.setWindowTitle("Desktop toolkit window")
    layout = QVBoxLayout()
    container = QWidget()
    container.setLayout(layout)
    window.setCentralWidget(container)

    def record(event):
        with log.open("a") as stream:
            stream.write(json.dumps({"event": event, "at": time.monotonic()}) + "\n")
            stream.flush()

    menu = window.menuBar().addMenu("File")
    menu.addAction("Record activation", lambda: record("menu-activation"))
    menu.addAction("Disabled entry").setEnabled(False)
    menu.aboutToShow.connect(lambda: record("menu-open"))
    menu.aboutToHide.connect(lambda: record("menu-closed"))
    button = QPushButton("Press me")
    button.setStatusTip("Pointer over the button")
    window.statusBar()
    button.clicked.connect(lambda: record("click"))
    layout.addWidget(button)
    field = QLineEdit()
    field.setAccessibleName("Text entry")
    field.setPlaceholderText("Type name")
    layout.addWidget(field)
    combo = QComboBox()
    combo.setAccessibleName("Delivery choice")
    combo.addItems(["Alpha", "Bravo", "Charlie"])
    combo.currentTextChanged.connect(lambda value: record("choice:" + value))
    layout.addWidget(combo)
    delayed = QPushButton("Delayed activation")
    delayed.setEnabled(False)
    delayed.clicked.connect(lambda: record("delayed-click"))
    layout.addWidget(delayed)
    enable = log.with_suffix(".enable")
    reset = log.with_suffix(".reset")
    timer = QTimer(window)

    def control():
        if reset.exists():
            reset.rename(log.with_suffix(".reset-consumed"))
            delayed.setEnabled(False)
        if enable.exists():
            enable.rename(log.with_suffix(".enable-consumed"))
            QTimer.singleShot(400, lambda: delayed.setEnabled(True))

    timer.timeout.connect(control)
    timer.start(20)
    offscreen = QLineEdit(container)
    offscreen.setAccessibleName("Offscreen entry")
    offscreen.setGeometry(10, 800, 200, 30)
    offscreen.show()
    window.resize(520, 260)
    window.show()
    record("started")
    return app.exec()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
