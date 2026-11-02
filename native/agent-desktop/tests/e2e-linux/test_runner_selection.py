import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import apps, gate, legs, main, readiness, report, session, stage
from contextlib import nullcontext


class RunnerSelectionTests(unittest.TestCase):
    def setUp(self):
        self.ready = mock.patch.object(readiness, "wait_ready").start()
        self.addCleanup(mock.patch.stopall)

    def test_outstanding_legs_do_not_start_a_desktop(self):
        leg = replace(legs.leg_by_id("observation.qualified_refs_survive_snapshots"),
                      disposition="outstanding", reason="pending fixture acceptance")
        with mock.patch.object(session, "start_tier", side_effect=AssertionError("desktop started")):
            outcomes = main._run_tier("x11-mutter", [leg], {}, Path("/unused"), False)
        self.assertEqual([(row.leg_id, row.outcome) for row in outcomes],
                         [(leg.id, "outstanding")])

    def test_desktop_priming_failure_is_a_named_tier_result(self):
        leg = legs.leg_by_id("observation.qualified_refs_survive_snapshots")
        with mock.patch.object(session, "start_tier", return_value=nullcontext(object())), \
            mock.patch.object(apps, "prime_desktop", side_effect=PermissionError("owned app stopping")):
            outcomes = main._run_tier("x11-openbox", [leg], {}, Path("/unused"), False)
        self.assertEqual([row.outcome for row in outcomes], [report.TIER_UNAVAILABLE])
        self.assertIn("owned app stopping", outcomes[0].detail)

    def test_desktop_services_are_primed_before_leg_baselines(self):
        tier = object()
        order = []
        leg = legs.leg_by_id("observation.qualified_refs_survive_snapshots")
        with tempfile.TemporaryDirectory() as directory, \
            mock.patch.object(session, "start_tier", return_value=nullcontext(tier)), \
            mock.patch.object(apps, "prime_desktop", create=True,
                              side_effect=lambda _: order.append("prime")), \
            mock.patch.object(main, "_run_leg", side_effect=lambda *a: order.append("leg")):
            main._run_tier("x11-openbox", [leg], {leg.id: object()}, Path(directory), False)
        self.assertEqual(order, ["prime", "leg"])

    def test_leg_batches_and_tier_default_share_one_tier(self):
        ids = ("observation.qualified_refs_survive_snapshots", "observation.stale_ref_after_app_killed")
        results = [report.LegOutcome(name, "x11-openbox", "headless", "pass") for name in ids]
        for selection in (",".join(ids), None):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as directory, \
                mock.patch.dict(os.environ, {main.SUITE_ENV: directory}), \
                mock.patch.object(main, "_acquire_lease", return_value=None), \
                mock.patch.object(main.signal, "signal"), \
                mock.patch.object(gate, "check_prerequisites", return_value=[]), \
                mock.patch.object(stage, "stage_binary", return_value=Path(directory) / "binary"), \
                mock.patch.object(session, "sweep_strays"), \
                mock.patch.object(session, "_remove_tree", return_value=True), \
                mock.patch.object(main, "_run_tier", return_value=results) as run:
                argv = ["--tier", "x11-openbox"]
                if selection:
                    argv += ["--leg", selection]
                code = main.main(argv)
                self.assertEqual(code, 0)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], "x11-openbox")
                selected = {leg.id for leg in run.call_args.args[1]}
                if selection:
                    self.assertEqual(selected, set(ids))
                else:
                    self.assertTrue(set(ids) <= selected)
                    self.assertGreater(len(selected), 2)
                    self.assertNotIn("wayland_input.first_key_lands", selected)


if __name__ == "__main__":
    unittest.main()
