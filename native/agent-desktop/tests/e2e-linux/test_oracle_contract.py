import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oracle import atspi_raw as raw, x11
from runner.helper import changed


class Clock:
    def __init__(self):
        self.now = 0.0

    def sleep(self, duration):
        self.now += duration


class RawOracleTests(unittest.TestCase):
    def test_state_words_cross_the_word_boundary(self):
        words = [(1 << 1) | (1 << 4) | (1 << 10) | (1 << 24) | (1 << 25), 1 << 9]
        self.assertEqual(raw.decode_states(words), frozenset({
            "ACTIVE", "CHECKED", "EXPANDED", "SENSITIVE", "SHOWING", "CHECKABLE"}))
        self.assertEqual(raw.decode_states([]), frozenset())
        self.assertEqual(raw.decode_states([1 << 8]), frozenset({"ENABLED"}))

    def test_showing_disabled_button_does_not_decode_as_sensitive(self):
        # AT-SPI GetState wire fixture: ENABLED/SENSITIVE absent, SHOWING/VISIBLE present.
        decoded = raw.decode_states([(1 << 25) | (1 << 30)])
        self.assertEqual(decoded, frozenset({"SHOWING", "VISIBLE"}))
        self.assertNotIn("SENSITIVE", decoded)

    def test_selectable_selected_sensitive_bits_decode_together(self):
        self.assertEqual(raw.decode_states([(1 << 22) | (1 << 23) | (1 << 24)]),
                         frozenset({"SELECTABLE", "SELECTED", "SENSITIVE"}))

    def test_fresh_states_are_not_cached(self):
        node = raw.RawNode(None, ":1.4", "/node")
        with patch.object(node, "invoke", side_effect=[([0],), ([1 << 24],)]):
            self.assertEqual(node.states, frozenset())
            self.assertEqual(node.states, frozenset({"SENSITIVE"}))

    def test_coordinates_and_text_use_the_raw_protocol(self):
        seen = []

        def reply(connection, bus, path, interface, method, signature="()", args=()):
            seen.append((method, signature, args))
            if method == "GetInterfaces":
                return (["org.a11y.atspi.Text"],)
            if method == "GetText":
                return ("café",)
            if method == "Get":
                return (4,)
            return ((10, -20, 80, 40),)

        with patch.object(raw, "call", side_effect=reply):
            node = raw.RawNode(None, ":1.4", "/node")
            self.assertEqual(node.extents(True), (10, -20, 80, 40))
            self.assertEqual(node.extents(), (10, -20, 80, 40))
            self.assertEqual(node.text(), "café")
        self.assertEqual(seen[0], ("GetExtents", "(u)", (1,)))
        self.assertEqual(seen[1], ("GetExtents", "(u)", (0,)))
        self.assertIn(("GetText", "(ii)", (0, 4)), seen)

    def test_missing_optional_interfaces_are_absent(self):
        node = raw.RawNode(None, ":1.4", "/node")
        with patch.object(node, "interfaces", return_value=[]):
            self.assertIsNone(node.text())
            self.assertIsNone(node.value())

    def test_named_action_uses_the_matching_index(self):
        node = raw.RawNode(None, ":1.4", "/node")
        with patch.object(node, "get_property", return_value=2), patch.object(
                node, "invoke", side_effect=[("Toggle",), ("Press",), (True,)]) as invoke:
            self.assertTrue(node.do_action("press"))
            self.assertEqual(invoke.call_args.args[2:], ("(i)", (1,)))
        with patch.object(node, "get_property", return_value=0):
            self.assertFalse(node.do_action("absent"))

    def test_child_walk_removes_nulls_and_cycles(self):
        def reply(connection, bus, path, interface, method, signature="()", args=()):
            if method == "GetChildren":
                return ([("", "/leaf"), (bus, "/org/a11y/atspi/null")] if path == "/root"
                        else [(bus, "/root")],)
            if method == "GetRole":
                return (43 if path == "/leaf" else 75,)
            if method == "Get":
                return ("7" if path == "/leaf" else "Calculator",)
            raise AssertionError(method)

        with patch.object(raw, "call", side_effect=reply):
            node = raw.RawNode(None, ":1.4", "/root")
            self.assertEqual([item.path for item in node.walk()], ["/root", "/leaf"])
            self.assertEqual([item.path for item in node.find(role=43, name="7")], ["/leaf"])
            self.assertEqual(node.find(role=7), [])

    def test_poll_returns_false_at_deadline(self):
        clock = Clock()
        with patch.object(raw.time, "monotonic", side_effect=lambda: clock.now), patch.object(
                raw.time, "sleep", side_effect=clock.sleep):
            self.assertEqual(raw.poll(lambda: [], 0.2), [])
        self.assertAlmostEqual(clock.now, 0.2)

    def test_poll_requires_both_truth_and_floor(self):
        clock = Clock()
        with patch.object(raw.time, "monotonic", side_effect=lambda: clock.now), patch.object(
                raw.time, "sleep", side_effect=clock.sleep):
            self.assertEqual(raw.poll(lambda: "ready" if clock.now >= 0.1 else "", 0.5, floor_s=0.2), "ready")
        self.assertGreaterEqual(clock.now, 0.2)
        self.assertLess(clock.now, 0.5)

    def test_zero_poll_does_one_read(self):
        values = []
        self.assertFalse(raw.poll(lambda: values.append(1), 0))
        self.assertEqual(values, [1])
        with self.assertRaises(ValueError):
            raw.poll(lambda: True, 0.1, floor_s=0.2)

    def test_changed_rejects_a_success_without_an_effect(self):
        with self.assertRaises(AssertionError):
            changed(lambda: "", "7", seconds=0)
        self.assertEqual(changed(lambda: "7", "7", seconds=0), "7")


class X11Tests(unittest.TestCase):
    def test_window_properties_normalise_ids_without_parsing_labels(self):
        self.assertEqual(x11.window_ids("_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0xA, 0x0, 0x2f"),
                         ["0xa", "0x2f"])
        self.assertEqual(x11.window_ids("_NET_ACTIVE_WINDOW: no such atom"), [])

    def test_geometry_uses_client_origin_and_rejects_missing_fields(self):
        text = "  Absolute upper-left X:  -12\n  Absolute upper-left Y:  37\n  Width: 420\n  Height: 260\n"
        self.assertEqual(x11.parse_geometry(text), (-12, 37, 420, 260))
        with self.assertRaises(ValueError):
            x11.parse_geometry(text.replace("Height: 260", "Height: 0"))
        with self.assertRaises(ValueError):
            x11.parse_geometry("Width: 420\nHeight: 260")

    def test_pointer_uses_named_axes(self):
        self.assertEqual(x11.parse_pointer("Y=-3\nX=200\nSCREEN=0\nWINDOW=0"), (200, -3))
        with self.assertRaises(KeyError):
            x11.parse_pointer("X=2")
