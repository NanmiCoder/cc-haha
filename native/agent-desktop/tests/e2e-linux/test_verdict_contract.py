from __future__ import annotations

import json
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from runner import apps, main, report, session, verdict
from runner.legs import Leg
from runner.product import Envelope
from runner.session import Tier
from runner.verdict import LegContext


def fake_tier(root: Path) -> Tier:
    runtime = Path(root) / "rt.test"
    runtime.mkdir(exist_ok=True)
    return Tier(
        name="x11-openbox",
        runtime_dir=runtime,
        display=":100",
        wayland_display=None,
        bus_address="unix:path=/nonexistent/bus",
        a11y_bus_address="unix:path=/nonexistent/atspi",
        state_root=runtime,
        keyfile=runtime / "keyfile",
        env={},
    )


def atspi_leg() -> Leg:
    return Leg(
        id="t.leg",
        requirement="r",
        target="t",
        tiers=("x11-openbox",),
        modes=("headless",),
        oracles=("atspi", "proc"),
        disposition="pass",
    )


class VerdictRuleTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.tier = fake_tier(Path(self.root.name))
        self.members = [frozenset({(10, 100), (11, 110)})]

    def ctx(self, leg=None, mode="headless") -> LegContext:
        return LegContext(
            self.tier, mode, leg, member_reader=lambda tier: self.members[0]
        )

    def test_completed_leg_evidence_keeps_its_verdict_before_suite_completion(self):
        def seeded_failure(ctx):
            ctx.before("atspi", "unchanged")
            ctx.after("atspi", "unchanged")
            raise AssertionError("seeded failure for retained evidence")

        suite = Path(self.root.name) / "suite"
        leg = atspi_leg()
        outcome = main._run_leg(seeded_failure, leg, self.tier,
                                "x11-openbox", "headless", suite, verdict, report)
        evidence = json.loads(main._evidence_path(suite, "x11-openbox", "headless", leg.id).read_text())
        self.assertEqual(outcome.outcome, "fail")
        self.assertEqual(evidence["outcome"], "fail")
        self.assertIn("seeded failure", evidence["detail"])

        def cleanup_masks_failure(ctx):
            try:
                raise AssertionError("original scenario failure")
            finally:
                raise RuntimeError("cleanup failure")
        main._run_leg(cleanup_masks_failure, leg, self.tier,
                      "x11-openbox", "headless", suite, verdict, report)
        evidence = json.loads(main._evidence_path(suite, "x11-openbox", "headless", leg.id).read_text())
        self.assertIn("original scenario failure", evidence.get("exception_traceback", ""))
        self.assertIn("cleanup failure", evidence["exception_traceback"])

    def test_failed_leg_recovery_keeps_evidence_and_never_signals_reused_pid(self):
        for reused in (False, True):
            with self.subTest(reused=reused):
                self.members[0] = frozenset({(10, 100)})

                def leak(ctx):
                    ctx.before("atspi", "unchanged")
                    ctx.after("atspi", "unchanged")
                    ctx.restored("atspi", "unchanged")
                    self.members[0] |= {(12, 120)}

                def kill(pid, sig, start, runtime, proc_root):
                    self.assertEqual((pid, sig, start, runtime, proc_root),
                                     (12, signal.SIGTERM, 120, self.tier.runtime_dir, Path("/proc")))
                    self.members[0] -= {(pid, 120)}

                suite = Path(self.root.name) / str(reused)
                with mock.patch.dict(apps._TIERS, {(12, 120): self.tier}, clear=True), \
                    mock.patch.object(verdict, "_proc_members", side_effect=lambda _: list(self.members[0])), \
                    mock.patch.object(session, "_process_start_time", return_value=121 if reused else 120), \
                    mock.patch.object(session, "_kill", side_effect=kill) as send, \
                    mock.patch.object(main.time, "monotonic", side_effect=[0, 2, 3, 5]):
                    outcome = main._run_leg(leak, atspi_leg(), self.tier,
                                            "x11-openbox", "headless", suite, verdict, report)
                self.assertEqual(outcome.outcome, "fail")
                evidence = json.loads(main._evidence_path(suite, "x11-openbox", "headless", "t.leg").read_text())
                self.assertIn([12, 120], evidence["owned_final"])
                self.assertIn("owned-process set changed", outcome.detail)
                if reused:
                    send.assert_not_called()
                    self.assertTrue(any("recovery" in item for item in outcome.findings))
                else:
                    send.assert_called_once_with(12, signal.SIGTERM, 120, self.tier.runtime_dir, Path("/proc"))
                    self.assertEqual(self.members[0], {(10, 100)})

    def test_private_service_churn_is_not_an_attributed_app_leak(self):
        self.members[0] = frozenset({(10, 100), (12, 120)})
        with mock.patch.dict(apps._TIERS, {(12, 120): self.tier}, clear=True), \
             mock.patch.object(verdict, "_proc_members", side_effect=lambda _: list(self.members[0])), \
             mock.patch.object(session, "_kill") as send:
            ctx = LegContext(self.tier, "headless", atspi_leg())
            ctx.before("atspi", "unchanged")
            ctx.after("atspi", "unchanged")
            ctx.restored("atspi", "unchanged")
            self.members[0] = frozenset({(11, 110), (12, 120)})
            self.assertEqual(verdict.evaluate(ctx), [])
            main._recover_failed_members(ctx)
            send.assert_not_called()
            self.assertEqual(ctx.owned().members, {(12, 120)})

    def test_evidence_write_failure_is_an_error_even_for_a_passing_leg(self):
        from runner import gate, stage

        def observed(ctx):
            ctx.before("atspi", "unchanged")
            ctx.after("atspi", "unchanged")
            ctx.restored("atspi", "unchanged")

        suite = Path(self.root.name) / "suite"
        suite.mkdir()
        with mock.patch.object(main, "_write_evidence", side_effect=OSError("disk full")):
            outcome = main._run_leg(observed, atspi_leg(), self.tier,
                                    "x11-openbox", "headless", suite, verdict, report)
        self.assertEqual(outcome.outcome, report.ERROR)
        self.assertEqual(report.count_failures([outcome]), 1)
        self.assertIn("evidence could not be written: disk full", report.render([outcome]))
        with mock.patch.dict(main.os.environ, {main.SUITE_ENV: str(suite)}), \
            mock.patch.object(main, "_acquire_lease", return_value=None), \
            mock.patch.object(gate, "check_prerequisites", return_value=[]), \
            mock.patch.object(stage, "stage_binary", return_value=suite / "binary"), \
            mock.patch.object(session, "sweep_strays"), \
            mock.patch.object(main.signal, "signal"), \
            mock.patch.object(main, "_run_tier", return_value=[outcome]):
            status = main.main(["--tier", "x11-openbox", "--leg", "events.window_closed_transition"])
        self.assertEqual(status, 1)
        self.assertTrue(suite.is_dir(), "the failed run deleted its diagnostic directory")

    def test_a_leg_with_no_oracle_read_fails(self):
        failures = verdict.evaluate(self.ctx())
        self.assertTrue(any("before" in f for f in failures))
        self.assertTrue(any("after" in f for f in failures))

    def test_before_without_after_fails(self):
        ctx = self.ctx()
        ctx.before("atspi", {"name": "calc"})
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("after" in f for f in failures))

    def test_after_without_before_fails(self):
        ctx = self.ctx()
        ctx.after("atspi", {"name": "calc"})
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("before" in f for f in failures))

    def test_unchanged_reads_pass(self):
        ctx = self.ctx()
        ctx.before("atspi", {"display": "7"})
        ctx.after("atspi", {"display": "7"})
        ctx.restored("atspi", {"display": "7"})
        self.assertEqual(verdict.evaluate(ctx), [])

    def test_change_with_matching_restoration_passes(self):
        ctx = self.ctx()
        ctx.before("atspi", "off")
        ctx.after("atspi", "on")
        ctx.restored("atspi", "off")
        self.assertEqual(verdict.evaluate(ctx), [])

    def test_change_without_restoration_fails(self):
        ctx = self.ctx()
        ctx.before("atspi", "off")
        ctx.after("atspi", "on")
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("restored read" in f for f in failures))

    def test_change_with_wrong_restoration_fails(self):
        ctx = self.ctx()
        ctx.before("atspi", "off")
        ctx.after("atspi", "on")
        ctx.restored("atspi", "half")
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("not restored" in f for f in failures))

    def test_restoration_disagreeing_without_change_fails(self):
        ctx = self.ctx()
        ctx.before("atspi", "off")
        ctx.after("atspi", "off")
        ctx.restored("atspi", "half")
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("drifted" in f for f in failures))

    def test_restoration_alone_fails(self):
        ctx = self.ctx()
        ctx.restored("atspi", "off")
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("before" in f for f in failures), failures)
        self.assertTrue(any("after" in f for f in failures), failures)

    def test_joined_attributed_app_fails_the_leg(self):
        ctx = self.ctx()
        ctx.before("atspi", "a")
        ctx.after("atspi", "a")
        ctx.restored("atspi", "a")
        self.members[0] = self.members[0] | {(12, 120)}
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("owned-process set changed" in f for f in failures))
        self.assertTrue(any("joined" in f for f in failures))

    def test_departed_attributed_app_fails_the_leg(self):
        ctx = self.ctx()
        ctx.before("atspi", "a")
        ctx.after("atspi", "a")
        ctx.restored("atspi", "a")
        self.members[0] = frozenset({(10, 100)})
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("owned-process set changed" in f for f in failures))
        self.assertTrue(any("left" in f for f in failures))

    def test_restarted_process_same_pid_different_start_fails(self):
        ctx = self.ctx()
        ctx.before("atspi", "a")
        ctx.after("atspi", "a")
        ctx.restored("atspi", "a")
        self.members[0] = frozenset({(10, 100), (11, 999)})
        failures = verdict.evaluate(ctx)
        self.assertTrue(any("owned-process set changed" in f for f in failures))


class ReadDisciplineTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.tier = fake_tier(Path(self.root.name))

    def ctx(self, leg=None) -> LegContext:
        return LegContext(self.tier, "headless", leg, member_reader=lambda tier: frozenset())

    def test_unknown_channel_is_refused(self):
        ctx = self.ctx()
        with self.assertRaises(ValueError):
            ctx.before("laser", 1)

    def test_named_observations_share_the_declared_oracle(self):
        ctx = self.ctx(leg=atspi_leg())
        ctx.before("atspi.selection", False)
        ctx.after("atspi.selection", True)
        self.assertTrue(any("restored read" in message for message in verdict.evaluate(ctx)))
        ctx.restored("atspi.selection", False)
        self.assertEqual(verdict.evaluate(ctx), [])
        for channel in ("laser.selection", "x11.pointer"):
            with self.assertRaises(ValueError):
                ctx.before(channel, None)

    def test_an_unrelated_observation_cannot_mask_a_failed_restoration(self):
        ctx = self.ctx(leg=atspi_leg())
        ctx.before("atspi.selection", False)
        ctx.after("atspi.selection", True)
        ctx.before("atspi.other", True)
        ctx.after("atspi.other", True)
        ctx.restored("atspi.selection", True)
        self.assertTrue(any("not restored" in item for item in verdict.evaluate(ctx)))

    def test_repeating_a_stage_keeps_every_value(self):
        ctx = self.ctx()
        ctx.before("atspi", None)
        ctx.before("atspi", {"window": (1, 2)})
        ctx.after("atspi", None)
        self.assertEqual(ctx.reads["atspi"]["before"], [None, {"window": (1, 2)}])
        self.assertEqual(ctx.reads["atspi"]["after"], [None])

    def test_findings_are_collected(self):
        ctx = self.ctx()
        ctx.finding("the app logged one warning")
        self.assertEqual(ctx.findings, ["the app logged one warning"])


class ProductForwardingTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.tier = fake_tier(Path(self.root.name))

    def test_headed_mode_forwards_headed(self):
        ctx = LegContext(
            self.tier, "headed", member_reader=lambda tier: frozenset()
        )
        captured = {}

        def fake_run_product(tier, argv, **kw):
            captured.update(kw)
            return Envelope(True, {}, None, "{}", 1.0, list(argv))

        with mock.patch.object(verdict, "run_product", fake_run_product):
            ctx.product(["snapshot"])
        self.assertTrue(captured.get("headed"))

    def test_headless_mode_forwards_no_headed(self):
        ctx = LegContext(
            self.tier, "headless", member_reader=lambda tier: frozenset()
        )
        captured = {}

        def fake_run_product(tier, argv, **kw):
            captured.update(kw)
            return Envelope(True, {}, None, "{}", 1.0, list(argv))

        with mock.patch.object(verdict, "run_product", fake_run_product):
            ctx.product(["snapshot"])
        self.assertFalse(captured.get("headed"))

    def test_product_calls_are_recorded(self):
        ctx = LegContext(
            self.tier, "headless", member_reader=lambda tier: frozenset()
        )

        def fake_run_product(tier, argv, **kw):
            return Envelope(True, {}, None, "{}", 1.0, list(argv))

        with mock.patch.object(verdict, "run_product", fake_run_product):
            ctx.product(["snapshot"])
            ctx.product(["click", "@e1"])
        self.assertEqual(len(ctx.products), 2)
        self.assertEqual(ctx.products[1].argv[-1], "@e1")


if __name__ == "__main__":
    unittest.main()
