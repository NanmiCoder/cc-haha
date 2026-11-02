import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import batch_contract

LEG = "batch_contract.entry_failure_and_stop_on_error"


def entry(index, ok, code=None):
    row = {"index": index, "ok": ok, "execution": "completed"}
    if not ok:
        row["error"] = {"code": code}
    return row


def continued():
    return {"results": [entry(0, True), entry(1, False, "STALE_REF"), entry(2, True)],
            "total_entries": 3, "completed_entries": 3, "not_started_entries": 0}


def halted():
    return {"results": [entry(0, True), entry(1, False, "STALE_REF")],
            "total_entries": 3, "completed_entries": 2, "not_started_entries": 1,
            "stopped": {"reason": "stop_on_error", "index": 1}}


class BatchVerdictTests(unittest.TestCase):
    def test_faithful_runs_are_accepted(self):
        self.assertEqual(batch_contract.batch_verdict(continued(), stop=False), [])
        self.assertEqual(batch_contract.batch_verdict(halted(), stop=True), [])

    def test_each_deviation_is_a_problem(self):
        def without(data, key):
            return {name: value for name, value in data.items() if name != key}

        wrong_code = continued()
        wrong_code["results"][1] = entry(1, False, "ELEMENT_NOT_FOUND")
        later_skipped = continued()
        later_skipped["results"][2] = entry(2, False, "STALE_REF")
        marked = dict(continued(), stopped={"reason": "stop_on_error", "index": 1})
        wrong_index = dict(halted(), stopped={"reason": "stop_on_error", "index": 0})
        wrong_counters = dict(halted(), completed_entries=3, not_started_entries=0)
        for name, data, stop in (
            ("wrong entry code", wrong_code, False),
            ("later entry did not run", later_skipped, False),
            ("stop marker without the flag", marked, False),
            ("stop run ran every entry", continued(), True),
            ("missing stop marker", without(halted(), "stopped"), True),
            ("wrong stop index", wrong_index, True),
            ("wrong counters", wrong_counters, True),
            ("flagless run stopped early", halted(), False),
            ("no results", {}, False),
        ):
            with self.subTest(name=name):
                self.assertNotEqual(batch_contract.batch_verdict(data, stop=stop), [])

    def test_entries_carry_the_missing_ref_between_two_real_ones(self):
        rows = json.loads(batch_contract._entries("@s1:e1", "@s1:e2", "@s1:e999999"))
        self.assertEqual([row["args"]["ref_id"] for row in rows], ["@s1:e1", "@s1:e999999", "@s1:e2"])
        self.assertEqual({row["command"] for row in rows}, {"click"})


class RestorationTests(unittest.TestCase):
    def run_leg(self, stop_runs_everything=False):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=None)
        app = SimpleNamespace(windows=["w-calculator"])
        shown = [""]
        ctx = LegContext(tier, "headless", legs.leg_by_id(LEG), member_reader=lambda _: frozenset())

        def product(tier, argv, **kw):
            self.assertEqual(argv[0], "batch")
            stop = "--stop-on-error" in argv
            if stop and not stop_runs_everything:
                shown[0] += "7"
                return Envelope(True, halted(), None, "{}", 0, argv, 0)
            shown[0] += "78"
            return Envelope(True, halted() if stop else continued(), None, "{}", 0, argv, 0)

        def undo(_node):
            shown[0] = shown[0][:-1]

        with patch.object(batch_contract, "managed") as managed, \
            patch.object(batch_contract, "root", return_value=app), \
            patch.object(batch_contract, "ref", side_effect=lambda ctx, app, role, name: f"@s1:e{name}"), \
            patch.object(batch_contract, "one", return_value=object()), \
            patch.object(batch_contract, "display", side_effect=lambda _: shown[0]), \
            patch.object(batch_contract, "activate", side_effect=undo), \
            patch("runner.helper.raw.poll", side_effect=lambda read, *a, **k: read()), \
            patch("runner.verdict.run_product", side_effect=product):
            managed.return_value.__enter__.return_value = app
            batch_contract.entry_failure_and_stop_on_error(ctx)
        return ctx, shown

    def test_faithful_product_restores_the_display(self):
        ctx, shown = self.run_leg()
        self.assertEqual(verdict.evaluate(ctx), [])
        self.assertEqual(shown[0], "")
        self.assertEqual(ctx.reads["atspi"], {"before": [""], "after": ["7"], "restored": [""]})

    def test_a_stop_run_that_still_clicks_the_last_entry_fails_the_leg(self):
        with self.assertRaises(AssertionError):
            self.run_leg(stop_runs_everything=True)


if __name__ == "__main__":
    unittest.main()
