import contextlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner.legs import leg_by_id
from runner.product import Envelope
from runner.verdict import LegContext, evaluate
from scenarios import pointer, ref_text
from scenarios.ref_effects import LINE, selections
from scenarios import ref_effects


class SelectionTests(unittest.TestCase):
    def test_each_mode_resets_and_observes_the_editor_before_preparing_its_document(self):
        state = ["headless residue"]
        def invoke(interface, method, signature, args):
            state[0] = args[0]
            return (True,)
        field = SimpleNamespace(text=lambda: state[0], invoke=invoke)
        ctx = SimpleNamespace(before=lambda *a: None, after=lambda *a: None,
                              restored=lambda *a: None)
        with patch.object(ref_effects, "managed", return_value=contextlib.nullcontext(object())), \
             patch.object(ref_effects, "root"), patch.object(ref_effects, "one", return_value=field), \
             patch.object(ref_effects, "ref", return_value="@s:e1"), \
             patch.object(ref_effects, "clear_selection"):
            for mode in ("headless", "headed"):
                ctx.mode = mode
                state[0] = mode + " saved draft"
                with ref_effects.editor(ctx):
                    self.assertEqual(state[0], (LINE + "\n") * 120)
                self.assertEqual(state[0], "")

    def test_selection_cleanup_requires_the_owned_active_window(self):
        ctx = SimpleNamespace(tier=object())
        app = SimpleNamespace(windows=["owned"])
        selected = [True]
        field = SimpleNamespace(invoke=lambda *_args: (int(selected[0]),))
        def tool(tier, argv):
            self.assertEqual(argv, ["xdotool", "key", "Right"])
            selected[0] = False
        with patch.object(ref_effects.x11, "xid", return_value="0x1"), \
             patch.object(ref_effects.x11, "active_window", return_value="0x2"), \
             patch.object(ref_effects.x11, "tool", side_effect=tool) as send:
            with self.assertRaisesRegex(AssertionError, "cleanup target is not active"):
                ref_effects.clear_selection(ctx, app, field)
            send.assert_not_called()
        with patch.object(ref_effects.x11, "xid", return_value="0x1"), \
             patch.object(ref_effects.x11, "active_window", return_value="0x1"), \
             patch.object(ref_effects.x11, "tool", side_effect=tool) as send:
            ref_effects.clear_selection(ctx, app, field)
            send.assert_called_once()
        self.assertFalse(selected[0])

    def test_headless_drift_is_restored_before_reporting_failure(self):
        tier = SimpleNamespace()
        ctx = LegContext(tier, "headless", member_reader=lambda _: frozenset())
        state = {"pointer": (10, 10), "active": "0x1"}
        def restore_active(tier, value):
            state["active"] = value
        def tool(tier, argv):
            state["pointer"] = tuple(map(int, argv[-2:]))
        with patch.object(ref_effects.x11, "pointer", side_effect=lambda _: state["pointer"]), \
             patch.object(ref_effects.x11, "active_window", side_effect=lambda _: state["active"]), \
             patch.object(ref_effects.x11, "restore_active", restore_active), \
             patch.object(ref_effects.x11, "tool", tool):
            with self.assertRaisesRegex(AssertionError, "headless action moved"):
                with ref_effects.desktop_restored(ctx):
                    state.update(pointer=(20, 30), active="0x2")
        self.assertEqual(state, {"pointer": (10, 10), "active": "0x1"})
        self.assertEqual(ctx.reads["x11.desktop"]["restored"], [((10, 10), "0x1")])

    def test_word_line_and_drag_require_their_actual_selection(self):
        field = SimpleNamespace(text=lambda: LINE + "\n")
        cases = (("double-click", ((6, 11),), True),
                 ("double-click", ((0, len(LINE)),), False),
                 ("triple-click", ((0, len(LINE) + 1),), True),
                 ("triple-click", ((6, 11),), False),
                 ("drag", ((1, 8),), True), ("drag", (), False))
        for verb, spans, valid in cases:
            with self.subTest(verb=verb, spans=spans), patch.object(ref_text, "selections", return_value=spans):
                if valid:
                    self.assertEqual(ref_text.selection_effect(field, verb), spans)
                else:
                    with self.assertRaises(AssertionError):
                        ref_text.selection_effect(field, verb)

    def test_selection_reader_uses_offsets_from_each_raw_selection(self):
        def invoke(interface, method, signature="()", args=()):
            return {"GetNSelections": (2,), "GetSelection": ((3, 8) if args == (0,) else (12, 18))}[method]
        self.assertEqual(selections(SimpleNamespace(invoke=invoke)), ((3, 8), (12, 18)))


class PointerEffectTests(unittest.TestCase):
    def run_delivery(self, verb, *, effect=True, refusal_changes=False, restore=True):
        tier = SimpleNamespace(runtime_dir=Path("/nonexistent/private"))
        leg = leg_by_id("pointer." + verb.replace("-", "_") + "_delivery_report")
        ctx = LegContext(tier, "headed", leg, member_reader=lambda _: frozenset())
        initial = "" if verb == "mouse-click" else 0
        effect_value = "7" if verb == "mouse-click" else 1
        state = {"effect": initial, "pointer": (10, 10)}
        @contextlib.contextmanager
        def target(*_):
            def undo():
                if restore:
                    state["effect"] = initial
            yield (20, 30), [verb], lambda: state["effect"], undo
        def product(tier, argv, **kw):
            if len(ctx.products) == 0:
                state["pointer"] = (110, 30) if verb == "drag" else (20, 30)
                state["effect"] = effect_value if effect else initial
                return Envelope(True, {"disposition": {"delivery": "delivered_unverified"},
                    "details": {"delivered_events": 3}, "steps": ["press"]}, None, "{}", 0, argv)
            if refusal_changes:
                state["effect"] = "unexpected effect"
            return Envelope(False, None, {"code": "INVALID_ARGS", "details": {
                "screen_width": 320, "screen_height": 240}, "disposition": {
                "delivery": "not_delivered"}}, "{}", 0, argv)
        def tool(tier, argv):
            state["pointer"] = tuple(map(int, argv[-2:]))
        with patch.object(pointer, "delivery_target", target), \
             patch.object(pointer.x11, "pointer", side_effect=lambda _: state["pointer"]), \
             patch.object(pointer.x11, "tool", tool), \
             patch.object(pointer.atspi_raw, "poll", side_effect=lambda predicate, *_a, **_k: predicate()), \
             patch("runner.verdict.run_product", product):
            pointer._delivery_leg(ctx, verb)
        return ctx

    def test_delivered_click_drag_and_wheel_require_application_effect(self):
        for verb in ("mouse-click", "drag", "mouse-wheel"):
            with self.subTest(verb=verb):
                with self.assertRaisesRegex(AssertionError, "no independent application effect"):
                    self.run_delivery(verb, effect=False)
                ctx = self.run_delivery(verb)
                self.assertEqual(ctx.reads["atspi.effect"], {
                    "before": ["" if verb == "mouse-click" else 0],
                    "after": ["7" if verb == "mouse-click" else 1],
                    "restored": ["" if verb == "mouse-click" else 0]})
                self.assertEqual(evaluate(ctx), [])

    def test_not_delivered_requires_no_application_effect(self):
        with self.assertRaisesRegex(AssertionError, "not_delivered refusal changed"):
            self.run_delivery("mouse-click", refusal_changes=True)

    def test_restoration_requires_the_real_application_baseline(self):
        with self.assertRaisesRegex(AssertionError, "oracle never reached"):
            self.run_delivery("mouse-click", restore=False)
