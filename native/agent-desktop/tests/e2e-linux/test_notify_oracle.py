from __future__ import annotations

import sys
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oracle import notify


class NotificationIdTests(unittest.TestCase):
    def test_last_integer_wins(self) -> None:
        self.assertEqual(notify.parse_notification_id("queued 3\nid 41\n"), 41)

    def test_missing_id_raises(self) -> None:
        with self.assertRaises(ValueError):
            notify.parse_notification_id("no identifiers here")


class IsolationTests(unittest.TestCase):
    def test_foreign_server_is_rejected_before_monitor_or_sender(self):
        tier = SimpleNamespace(runtime_dir=Path("/private"), bus_address="private-bus",
                               env={"AGENT_DESKTOP_PRIVATE_SESSION": "/private"})
        with patch.object(notify.raw, "connect"), patch.object(notify.raw, "call", return_value=(42,)), \
                patch.object(notify.proc, "facts", return_value=(1, 1, "gnome-shell", {"XDG_RUNTIME_DIR": "/live"})), \
                patch.object(notify, "monitor") as monitor, patch.object(notify, "send") as send:
            with self.assertRaisesRegex(AssertionError, "server escaped the private runtime"):
                with notify.observing(SimpleNamespace(tier=tier)):
                    self.fail("foreign notification server admitted")
            monitor.assert_not_called()
            send.assert_not_called()


class NotificationArgvTests(unittest.TestCase):
    def test_sender_script_receives_notification_fields(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / "arguments.json"
            gdbus = root / "gdbus"
            gdbus.write_text(f"#!{sys.executable}\nimport json, sys\n"
                             f"open({str(capture)!r}, 'w').write(json.dumps(sys.argv[1:]))\n"
                             "print('(uint32 41,)')\n")
            gdbus.chmod(0o700)
            for body, actions, expected in (("Body", (("open", "Open"),), "['open', 'Open']"),
                                             ("", (), "[]")):
                with self.subTest(body=body):
                    result = subprocess.run(notify.notification_argv("Harness", "Summary", body, actions),
                                            env=dict(os.environ, PATH=f"{root}:{os.environ['PATH']}"),
                                            capture_output=True, text=True, check=True)
                    self.assertEqual(notify.parse_notification_id(result.stdout), 41)
                    arguments = json.loads(capture.read_text())
                    self.assertEqual(arguments[arguments.index("org.freedesktop.Notifications.Notify") + 1:],
                                     ["Harness", "0", "", "Summary", body, expected, "{}", "0"])

    def test_monitor_filters_the_notification_interface(self) -> None:
        argv = notify.monitor_argv()
        self.assertEqual(argv[0], "dbus-monitor")
        self.assertIn("org.freedesktop.Notifications", argv[-1])


class MonitorDecoderTests(unittest.TestCase):
    SAMPLE = """signal time=1.0 sender=:1.2 -> destination=(null destination) serial=9 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=NotificationClosed
   uint32 7
   uint32 2

signal time=2.0 sender=:1.2 -> destination=(null destination) serial=10 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=ActionInvoked
   uint32 7
   string "open"

signal time=3.0 sender=:1.2 -> destination=(null destination) serial=11 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify
   string "unrelated"
"""

    def test_closed_and_invoked_are_decoded(self) -> None:
        signals = notify.parse_monitor_text(self.SAMPLE)
        self.assertEqual(
            signals,
            [
                ("NotificationClosed", {"id": 7, "reason": 2}),
                ("ActionInvoked", {"id": 7, "action": "open"}),
            ],
        )

    def test_adjacent_monitor_signals_preserve_their_own_payloads(self) -> None:
        self.assertEqual(notify.parse_monitor_text(self.SAMPLE.replace("\n\n", "\n")), [
            ("NotificationClosed", {"id": 7, "reason": 2}),
            ("ActionInvoked", {"id": 7, "action": "open"}),
        ])

    def test_empty_text_has_no_signals(self) -> None:
        self.assertEqual(notify.parse_monitor_text(""), [])


if __name__ == "__main__":
    unittest.main()
