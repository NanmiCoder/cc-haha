import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import occlusion


class OcclusionScenarioTests(unittest.TestCase):
    def test_cover_position_is_observed_inside_its_client_shadow(self):
        target = SimpleNamespace(windows=["w-target"])
        cover = SimpleNamespace(windows=["w-cover"])
        field = SimpleNamespace(extents=lambda **kw: (10, 10, 20, 20))
        tier = SimpleNamespace()
        ctx = SimpleNamespace(tier=tier, product=lambda argv: Envelope(True, {}, None, "{}", 0, argv))
        def geometry(tier, window):
            return (100, 100, 700, 520) if window == "w-target" else (39, 45, 740, 560)
        def changed(read, expected, **kw):
            self.assertEqual(read(), expected)
            return expected
        with patch.object(occlusion.apps, "launch", side_effect=[target, cover]), \
            patch.object(occlusion, "_write_document"), \
            patch.object(occlusion, "_document_node", return_value=field), \
            patch.object(occlusion.x11, "client_origin", return_value=(100, 100)), \
            patch.object(occlusion.x11, "geometry", side_effect=geometry), \
            patch.object(occlusion, "frame_extents", side_effect=lambda t, w: (0, 0, 0, 0)
                         if w == "w-target" else (61, 61, 55, 67)), \
            patch.object(occlusion, "changed", side_effect=changed):
            self.assertEqual(occlusion._setup(ctx), (target, "w-target", cover))

    def test_occlusion_uses_a_pointer_click_and_restores_effect_and_stacking(self):
        for name in ("ordinary_cover_removed_click_lands", "above_cover_refused_no_effect",
                     "above_flag_dropped_click_lands"):
            with self.subTest(leg=name):
                tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                target = SimpleNamespace(windows=["w-target"])
                cover = SimpleNamespace(windows=["w-cover"])
                state = {"document": ("baseline", 8), "above": False, "stack": ["w-target", "w-cover"]}
                ctx = LegContext(tier, "headed", legs.leg_by_id("occlusion." + name),
                                 member_reader=lambda _: frozenset())
                def product(tier, argv, **kw):
                    self.assertEqual(argv, ["click", "@s:e7"], "occlusion must exercise pointer dispatch")
                    if state["above"]:
                        return Envelope(False, None, {"code": "ACTION_FAILED",
                            "details": {"reason": "occluded by window"},
                            "disposition": {"delivery": "not_delivered"}}, "{}", 0, argv)
                    state.update(document=("baseline", 3), stack=["w-cover", "w-target"])
                    return Envelope(True, {}, None, "{}", 0, argv)
                def restore_document(*args):
                    state["document"] = ("baseline", 8)
                    return state["document"]
                def restore_active(*args):
                    state["stack"] = ["w-target", "w-cover"]
                    return "0x2"
                with patch.object(occlusion, "_setup", return_value=(target, "w-target", cover)), \
                    patch.object(occlusion, "_document", side_effect=lambda *a: state["document"]), \
                    patch.object(occlusion, "_cover_display", return_value=""), \
                    patch.object(occlusion, "_target_ref", return_value="@s:e7", create=True), \
                    patch.object(occlusion, "_restore_document", side_effect=restore_document), \
                    patch.object(occlusion, "_above_state", side_effect=lambda *a: state["above"], create=True), \
                    patch.object(occlusion.x11, "set_above", side_effect=lambda t, w, on: state.update(above=on)), \
                    patch.object(occlusion.x11, "stacking", side_effect=lambda *a: list(state["stack"])), \
                    patch.object(occlusion.x11, "xid", return_value="0x2"), \
                    patch.object(occlusion.x11, "restore_active", side_effect=restore_active), \
                    patch.object(occlusion.apps, "stop"), \
                    patch("runner.verdict.run_product", side_effect=product):
                    getattr(occlusion, name)(ctx)
                self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(state, {"document": ("baseline", 8), "above": False,
                                         "stack": ["w-target", "w-cover"]})
