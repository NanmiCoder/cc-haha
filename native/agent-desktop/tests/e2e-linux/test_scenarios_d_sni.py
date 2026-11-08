from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from xml.etree import ElementTree
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from apps import sni_item


class ItemXmlTests(unittest.TestCase):
    def test_menu_event_accepts_the_dbusmenu_wire_signature(self) -> None:
        method = ElementTree.fromstring(sni_item.MENU_XML).find(".//method[@name='Event']")
        self.assertEqual("".join(arg.attrib["type"] for arg in method
                                 if arg.attrib["direction"] == "in"), "isvu")
        self.assertFalse([arg for arg in method if arg.attrib["direction"] == "out"])

    def test_activate_present_by_default(self) -> None:
        xml = sni_item.item_xml()
        self.assertIn('name="Activate"', xml)
        self.assertIn("StatusNotifierItem", xml)

    def test_activate_absent_when_disabled(self) -> None:
        xml = sni_item.item_xml(False)
        self.assertNotIn('name="Activate"', xml)
        self.assertIn('name="SecondaryActivate"', xml)


class MenuEntryTests(unittest.TestCase):
    def test_entries_are_enabled_by_default(self) -> None:
        self.assertTrue(all(entry["enabled"] for entry in sni_item.menu_entries()))

    def test_disabled_entry_is_appended(self) -> None:
        entries = sni_item.menu_entries(True)
        self.assertFalse(entries[-1]["enabled"])
        self.assertEqual(entries[-1]["label"], "Disabled Entry")

    def test_ids_are_unique(self) -> None:
        ids = [entry["id"] for entry in sni_item.menu_entries(True)]
        self.assertEqual(len(ids), len(set(ids)))


class LogTests(unittest.TestCase):
    def test_call_round_trips(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "calls.log"
            sni_item.log_call(path, "Activate", {"values": [3, 4]})
            sni_item.log_call(path, "Event", {"id": 1, "event": "clicked"})
            calls = sni_item.parse_log_body(path.read_text(encoding="utf-8"))
        self.assertEqual(
            calls,
            [
                ("Activate", {"values": [3, 4]}),
                ("Event", {"id": 1, "event": "clicked"}),
            ],
        )

    def test_missing_log_reads_empty(self) -> None:
        self.assertEqual(sni_item.read_log(Path("/nonexistent/harness-tray.log")), [])

    def test_blank_lines_are_skipped(self) -> None:
        self.assertEqual(sni_item.parse_log_body("\n\n"), [])


class ArgTests(unittest.TestCase):
    def test_flags_are_parsed(self) -> None:
        args = sni_item.parse_args(
            ["--log", "/tmp/x", "--no-activate", "--no-menu", "--disabled-entry"]
        )
        self.assertTrue(args.no_activate and args.no_menu and args.disabled_entry)
        self.assertEqual(args.title, "Harness Tray")

    def test_log_is_required(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                sni_item.parse_args([])


if __name__ == "__main__":
    unittest.main()
