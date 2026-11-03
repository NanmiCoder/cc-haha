from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from oracle import atspi_raw as raw, x11


class X11ProductIdTests(unittest.TestCase):
    def setUp(self):
        self.tier = SimpleNamespace(a11y_bus_address="unix:path=/nonexistent/atspi", env={})

    def test_product_ids_round_trip_to_an_address(self):
        product = "w-1.7-org-a11y-atspi-accessible-1"
        self.assertEqual(x11.decode_product_id(product),
                         (":1.7", "/org/a11y/atspi/accessible/1"))
        bus, path = x11.decode_product_id(product)
        self.assertEqual(x11.encode_product_id(bus, path), product)
        with self.assertRaises(ValueError):
            x11.decode_product_id("0x2f")

    def test_geometry_accepts_a_product_window_id(self):
        text = "  Absolute upper-left X:  10\n  Absolute upper-left Y:  20\n  Width: 300\n  Height: 200\n"
        seen = []

        def tool(_tier, argv, **_kw):
            seen.append(argv)
            return text

        product = "w-1.7-org-a11y-atspi-accessible-1"
        with patch.object(x11, "xid", return_value="0x2f") as resolve, patch.object(
                x11, "tool", side_effect=tool):
            self.assertEqual(x11.geometry(self.tier, product), (10, 20, 300, 200))
            self.assertEqual(x11.client_origin(self.tier, product), (10, 20))
        resolve.assert_called_with(self.tier, product)
        self.assertEqual(seen[0], ["xwininfo", "-id", "0x2f"])

    def test_stacking_reports_product_window_ids(self):
        with patch.object(x11, "stacking_xids", return_value=["0xa", "0xb"]), patch.object(
                x11, "product_window", side_effect=["w-1.7-frame", "0xb"]):
            self.assertEqual(x11.stacking(self.tier), ["w-1.7-frame", "0xb"])

    def test_xid_resolves_the_single_owner_window(self):
        def tool(_tier, argv, **_kw):
            if argv[:2] == ["xprop", "-root"]:
                return "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0xa, 0xb"
            if argv[1:2] == ["-id"] and argv[-1] == "_NET_WM_PID":
                return "= 42" if argv[2] == "0xa" else "= 7"
            return '_NET_WM_NAME(UTF8_STRING) = "Calculator"'

        with patch.object(x11, "product_node", return_value=SimpleNamespace(name="Calculator")), patch.object(
                raw, "owner_pid", return_value=42), patch.object(x11, "tool", side_effect=tool):
            self.assertEqual(x11.xid(self.tier, "w-1.7-frame"), "0xa")


class PollTruthTests(unittest.TestCase):
    def test_poll_returns_the_truthy_predicate_value(self):
        value = ("ready", {"count": 2})
        self.assertEqual(raw.poll(lambda: value, 0), value)




if __name__ == "__main__":
    unittest.main()
