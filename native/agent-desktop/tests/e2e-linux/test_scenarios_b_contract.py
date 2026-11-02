import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from runner import helper
from runner.product import Envelope
from scenarios import scroll, toolkit_electron, toolkit_qt, values, zero_bounds


def envelope(*, ok=True, code=None, elapsed=2000, kind="actionability_timeout"):
    return Envelope(ok, {} if ok else None,
                    None if ok else {"code": code, "details": {"kind": kind}},
                    "captured envelope", elapsed, [])


class VerdictTests(unittest.TestCase):
    def test_click_log_counts_only_new_activations(self):
        before = ["started", "click"]
        self.assertEqual(toolkit_qt.click_delta(before, before + ["menu-open", "click"]), 1)
        self.assertEqual(toolkit_qt.click_delta(before, before), 0)
        self.assertEqual(toolkit_qt.click_delta(before, before + ["click", "click"]), 2)
        with self.assertRaises(AssertionError):
            toolkit_qt.click_delta(before, ["started", "menu-open"])

    def test_menu_log_uses_the_last_transition(self):
        self.assertFalse(toolkit_qt.menu_state(["started"]))
        self.assertTrue(toolkit_qt.menu_state(["menu-open", "menu-activation"]))
        self.assertFalse(toolkit_qt.menu_state(["menu-open", "menu-closed", "click"]))
        self.assertTrue(toolkit_qt.menu_state(["menu-open", "menu-closed", "menu-open"]))

    def test_scroll_value_stays_inside_the_reported_range(self):
        bar = SimpleNamespace(get_property=lambda interface, key: {"MinimumValue": 10, "MaximumValue": 110}[key])
        self.assertEqual(scroll.scroll_target(bar), 108)
        bar.get_property = lambda interface, key: 10
        with self.assertRaises(AssertionError):
            scroll.scroll_target(bar)

    def test_numeric_settings_decoder_preserves_signed_values(self):
        self.assertEqual(values.key_number("uint32 4"), 4)
        self.assertEqual(values.key_number("-0.25"), -0.25)
        with self.assertRaises(ValueError):
            values.key_number("'not numeric'")

    def test_zero_axis_is_not_negative_sentinel_geometry(self):
        self.assertTrue(zero_bounds.zero_axis((0, 0, 710, 0)))
        self.assertTrue(zero_bounds.zero_axis((0, 0, 0, 30)))
        self.assertFalse(zero_bounds.zero_axis((-1, -1, -1, -1)))
        self.assertFalse(zero_bounds.zero_axis((0, 0, 10, 20)))

    def test_false_delivery_and_wrong_refusal_are_rejected(self):
        ctx = SimpleNamespace(mode="headed", tier=SimpleNamespace(display=":1"),
                              product=lambda argv, **kw: envelope())
        with self.assertRaises(AssertionError):
            helper.command(ctx, ["click", "@s:e1"], code="ACTION_FAILED")
        ctx.product = lambda argv, **kw: envelope(ok=False, code="TIMEOUT")
        with self.assertRaises(AssertionError):
            helper.command(ctx, ["click", "@s:e1"])
        with self.assertRaises(AssertionError):
            helper.command(ctx, ["click", "@s:e1"], code="ACTION_FAILED")
        self.assertEqual(helper.command(ctx, ["click", "@s:e1"], code="TIMEOUT").error["code"], "TIMEOUT")

    def test_headless_effect_that_moves_focus_is_rejected(self):
        ctx = SimpleNamespace(mode="headless", tier=SimpleNamespace(display=":1"),
                              product=lambda argv, **kw: envelope())
        with patch.object(helper.x11, "pointer", return_value=(1, 2)), patch.object(
                helper.x11, "active_window", side_effect=["0x1", "0x2"]):
            with self.assertRaises(AssertionError):
                helper.command(ctx, ["click", "@s:e1"])

    def test_headless_effect_that_moves_pointer_is_rejected(self):
        ctx = SimpleNamespace(mode="headless", tier=SimpleNamespace(display=":1"),
                              product=lambda argv, **kw: envelope())
        with patch.object(helper.x11, "pointer", side_effect=[(1, 2), (3, 4)]), patch.object(
                helper.x11, "active_window", return_value="0x1"):
            with self.assertRaises(AssertionError):
                helper.command(ctx, ["click", "@s:e1"])

    def test_ref_decoder_requires_one_qualified_match(self):
        ctx = SimpleNamespace(mode="headed", tier=SimpleNamespace(display=":1"),
                              product=lambda argv, **kw: SimpleNamespace(ok=True, error=None,
                              data={"matches": [{"ref_id": "@s123:e7"}]}, raw=""))
        self.assertEqual(helper.ref(ctx, None, role="button", name="7"), "@s123:e7")
        for bad in ([], [{"ref_id": "@e7"}], [{"ref_id": "@s:e1"}, {"ref_id": "@s:e2"}]):
            ctx.product = lambda argv, **kw: SimpleNamespace(ok=True, error=None,
                                                           data={"matches": bad}, raw="")
            with self.subTest(bad=bad), self.assertRaises(AssertionError):
                helper.ref(ctx, None, role="button", name="7")

    def test_vanished_or_reused_frame_never_passes(self):
        app = SimpleNamespace(owner_names=[":1.7"], pid=123, start_time=90, windows=["w-1.7-frame"])
        frame = SimpleNamespace(bus=":1.7", path="/frame", role=23)
        owner = SimpleNamespace(bus=":1.7", children=lambda: [frame])
        ctx = SimpleNamespace(tier=object())
        with patch.object(toolkit_electron.raw, "registry", return_value=[owner]) as registry, patch.object(
                toolkit_electron.proc, "facts", return_value=(90, 123, "code", {})) as facts:
            self.assertEqual(toolkit_electron.frame_alive(ctx, app), ["w-1.7-frame"])
            registry.return_value = []
            with self.assertRaises(AssertionError):
                toolkit_electron.frame_alive(ctx, app)
            registry.return_value = [owner]
            owner.children = lambda: []
            with self.assertRaises(AssertionError):
                toolkit_electron.frame_alive(ctx, app)
            owner.children = lambda: [frame]
            facts.return_value = (91, 123, "code", {})
            with self.assertRaises(AssertionError):
                toolkit_electron.frame_alive(ctx, app)
