import types
import os
import subprocess
import sys
import unittest
from unittest import mock

from oracle import clipboard
from scenarios.clipboard import stop_owner


def _tier(wayland=None):
    return types.SimpleNamespace(wayland_display=wayland, env={})


class CommandTests(unittest.TestCase):
    def test_backend_follows_the_display(self):
        self.assertEqual(clipboard.backend(_tier()), "x11")
        self.assertEqual(clipboard.backend(_tier("wayland-0")), "wayland")

    def test_text_formats_map_to_the_x11_utf8_target(self):
        self.assertEqual(clipboard.xclip_target("text"), "UTF8_STRING")
        self.assertEqual(clipboard.xclip_target("text/plain"), "UTF8_STRING")
        self.assertEqual(clipboard.xclip_target("image/png"), "image/png")

    def test_x11_setter_runs_in_the_foreground(self):
        argv = clipboard.set_command("x11", "image/png")
        self.assertIn("-quiet", argv)
        self.assertNotIn("-silent", argv)
        self.assertIn("image/png", argv)
        self.assertNotIn("--foreground", argv)

    def test_wayland_setter_stays_in_the_foreground(self):
        argv = clipboard.set_command("wayland", "text/plain")
        self.assertEqual(argv[:2], ["wl-copy", "--foreground"])

    def test_reader_commands_name_the_same_format(self):
        self.assertIn("UTF8_STRING", clipboard.get_command("x11", "text"))
        self.assertIn("image/png", clipboard.get_command("wayland", "image/png"))


class ForeignClientTests(unittest.TestCase):
    def test_foreign_owner_cleanup_reaps_its_owned_child(self):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(60)"],
                                 stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with mock.patch.object(clipboard.subprocess, "Popen", return_value=child), \
                mock.patch.object(clipboard.time, "monotonic", side_effect=[0, 0, 3]), \
                mock.patch.object(clipboard.time, "sleep"):
                pid = clipboard.foreign_set(_tier(), "text/plain", b"value")
            stop_owner(pid)
            with self.assertRaises(ChildProcessError):
                os.waitpid(pid, os.WNOHANG)
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
            if child.stderr:
                child.stderr.close()

    def test_a_setter_that_exits_is_an_error(self):
        with mock.patch.object(clipboard, "set_command", return_value=["false"]):
            with self.assertRaises(clipboard.ClipboardError):
                clipboard.foreign_set(_tier(), "text/plain", b"value")

    def test_a_failed_reader_returns_none(self):
        with mock.patch.object(clipboard, "get_command", return_value=["false"]):
            self.assertIsNone(clipboard.foreign_get(_tier(), "text/plain"))

    def test_a_reader_returns_the_bytes_it_read(self):
        with mock.patch.object(clipboard, "_run", return_value=(0, b"payload", b"")):
            self.assertEqual(clipboard.foreign_get(_tier(), "text/plain"), b"payload")

    def test_a_reader_that_times_out_returns_none(self):
        with mock.patch.object(clipboard, "_run", return_value=(124, b"", b"")):
            self.assertIsNone(clipboard.foreign_get(_tier(), "text/plain"))


if __name__ == "__main__":
    unittest.main()
