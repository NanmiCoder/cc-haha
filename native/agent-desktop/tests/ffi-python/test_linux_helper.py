import os
import unittest
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock, patch

from linux_helper import read_foreign_text, verify, verify_cli


class HelperDiscoveryTests(unittest.TestCase):
    def test_foreign_reader_selects_matching_gtk_and_gdk(self):
        gi = Mock()
        clipboard = Mock()
        clipboard.wait_for_text.return_value = "foreign payload"
        gtk = Mock()
        gtk.Clipboard.get.return_value = clipboard
        repository = SimpleNamespace(Gtk=gtk, Gdk=SimpleNamespace(SELECTION_CLIPBOARD=7))
        with patch.dict("sys.modules", {"gi": gi, "gi.repository": repository}):
            self.assertEqual(read_foreign_text(), "foreign payload")
        self.assertEqual(gi.require_version.call_args_list,
                         [unittest.mock.call("Gtk", "3.0"), unittest.mock.call("Gdk", "3.0")])
        gtk.Clipboard.get.assert_called_once_with(7)

    def library(self):
        lib = Mock()
        lib.ad_adapter_create.side_effect = [11, 12]
        lib.ad_set_clipboard.return_value = 0
        lib.ad_clear_clipboard.return_value = 0
        return lib

    def test_set_uses_empty_path_and_outlives_the_adapter(self):
        lib = self.library()
        payload = []
        def write(adapter, value):
            self.assertEqual(os.environ["PATH"], "/empty-path")
            payload.append(value.decode())
            return 0
        lib.ad_set_clipboard.side_effect = write
        def read():
            lib.ad_adapter_destroy.assert_any_call(11)
            return payload[0] if lib.ad_clear_clipboard.call_count == 0 else None
        with patch.dict(os.environ, {"PATH": "/original"}):
            verify(lib, "/empty-path", read)
            self.assertEqual(os.environ["PATH"], "/original")
        lib.ad_clear_clipboard.assert_called_once_with(12)
        lib.ad_adapter_destroy.assert_any_call(12)

    def test_missing_owner_is_an_error_and_restores_path(self):
        lib = self.library()
        lib.ad_set_clipboard.return_value = 5
        lib.ad_last_error_message.return_value = b"clipboard owner helper is missing"
        reader = Mock()
        with patch.dict(os.environ, {"PATH": "/original"}):
            with self.assertRaisesRegex(AssertionError, "owner helper is missing"):
                verify(lib, "/empty-path", reader)
            self.assertEqual(os.environ["PATH"], "/original")
        reader.assert_not_called()

    def test_a_success_without_foreign_payload_fails(self):
        lib = self.library()
        with self.assertRaisesRegex(AssertionError, "foreign GTK reader"):
            verify(lib, "/empty-path", lambda: None)
        lib.ad_clear_clipboard.assert_called_once()

    def test_a_selection_surviving_clear_fails(self):
        lib = self.library()
        with self.assertRaisesRegex(AssertionError, "cleared selection"):
            verify(lib, "/empty-path", lambda: "agent-desktop-library-adjacent-owner")
        self.assertEqual(lib.ad_clear_clipboard.call_count, 2)


class InstalledHelperTests(unittest.TestCase):
    def test_installed_commands_use_empty_path_and_foreign_readback(self):
        calls = []
        def run(argv, **kwargs):
            self.assertEqual(kwargs["env"]["PATH"], "/empty")
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, '{"ok":true}', "")
        def read():
            return "agent-desktop-installed-owner" if len(calls) == 1 else None
        verify_cli("/entry", "/empty", read, run)
        self.assertEqual(calls, [["/entry", "clipboard-set", "agent-desktop-installed-owner"],
                                 ["/entry", "clipboard-clear"]])

    def test_installed_success_requires_foreign_payload(self):
        run = Mock(return_value=subprocess.CompletedProcess([], 0, '{"ok":true}', ""))
        with self.assertRaisesRegex(AssertionError, "foreign reader"):
            verify_cli("/entry", "/empty", lambda: None, run)
        self.assertEqual(run.call_count, 2)

    def test_installed_command_errors_fail_closed(self):
        for rc, body in ((1, '{"ok":true}'), (0, '{"ok":false}')):
            with self.subTest(rc=rc, body=body):
                run = Mock(return_value=subprocess.CompletedProcess([], rc, body, "missing helper"))
                reader = Mock()
                with self.assertRaisesRegex(AssertionError, "command failed"):
                    verify_cli("/entry", "/empty", reader, run)
                reader.assert_not_called()

    def test_installed_clear_requires_no_foreign_selection(self):
        run = Mock(return_value=subprocess.CompletedProcess([], 0, '{"ok":true}', ""))
        with self.assertRaisesRegex(AssertionError, "clear left"):
            verify_cli("/entry", "/empty", lambda: "agent-desktop-installed-owner", run)
        self.assertEqual(run.call_count, 3)
