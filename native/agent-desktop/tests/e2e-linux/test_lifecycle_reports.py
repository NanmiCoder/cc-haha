import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner import verdict
from scenarios import lifecycle
from test_review_scenario_regressions import context, envelope


class LifecycleReportTests(unittest.TestCase):
    def test_move_resize_and_minimize_reports_match_effects_in_both_directions(self):
        for fault in (None, "move-window:no-effect", "move-window:partial", "resize-window:no-effect", "resize-window:partial",
                      "minimize:no-effect", "move-window:positive-report", "resize-window:positive-report",
                      "minimize:positive-report", "move-window:unverified", "resize-window:unverified",
                      "minimize:unverified", "move-window:negative-report", "resize-window:negative-report",
                      "minimize:negative-report", "resize-window:negative-effect"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                ctx = context(directory, "lifecycle.window_operation_delivery_reports")
                geometry = [100, 100, 700, 520]
                hidden = [False]
                def product(tier, argv, **kw):
                    operation = argv[0]
                    missing = "w-missing" in argv
                    if missing:
                        if fault == operation + ":negative-effect":
                            geometry[0] += 1
                        delivery = "delivered_unverified" if fault == operation + ":negative-report" else "not_delivered"
                        return envelope(argv, error={"code": "WINDOW_NOT_FOUND", "disposition": {"delivery": delivery}})
                    if fault != operation + ":no-effect":
                        if operation == "move-window":
                            geometry[:2] = [int(argv[4]), int(argv[6])]
                            if fault == operation + ":partial":
                                geometry[1] -= 1
                        elif operation == "resize-window":
                            geometry[2:] = [int(argv[4]), int(argv[6])]
                            if fault == operation + ":partial":
                                geometry[3] -= 1
                        elif operation in ("minimize", "restore"):
                            hidden[0] = operation == "minimize"
                    delivery = "not_delivered" if fault == operation + ":positive-report" else ("delivered_unverified" if fault in (operation + ":unverified", operation + ":no-effect") else "delivered_verified")
                    return envelope(argv, {"disposition": {"delivery": delivery}})
                def observed(read, expected, **kw):
                    actual = read()
                    if actual != expected:
                        raise AssertionError(f"independent effect {actual!r} != {expected!r}")
                    return actual
                with patch.object(lifecycle.apps, "launch", return_value=SimpleNamespace(windows=["w-real"])), \
                     patch.object(lifecycle.apps, "stop"), \
                     patch.object(lifecycle, "_geometry", side_effect=lambda *a: tuple(geometry)), \
                     patch.object(lifecycle, "_wm_state", side_effect=lambda *a: "_NET_WM_STATE_HIDDEN" if hidden[0] else ""), \
                     patch.object(lifecycle, "changed", side_effect=observed), \
                     patch("runner.verdict.run_product", side_effect=product):
                    if fault is None:
                        lifecycle.window_operation_delivery_reports(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])
                    else:
                        with self.assertRaises(AssertionError):
                            lifecycle.window_operation_delivery_reports(ctx)
                if fault is None:
                    self.assertEqual(geometry, [100, 100, 700, 520])
                    self.assertFalse(hidden[0])
