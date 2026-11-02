import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import error_contract

LEG = "error_contract.recoverable_error_envelopes"
QUALIFIED = "Use the snapshot-qualified ref that snapshot prints"
NOT_DELIVERED = {"delivery": "not_delivered", "retry": "safe"}
FAITHFUL = {
    "INVALID_ARGS": {"code": "INVALID_ARGS", "suggestion": QUALIFIED, "disposition": NOT_DELIVERED},
    "SNAPSHOT_NOT_FOUND": {
        "code": "SNAPSHOT_NOT_FOUND",
        "suggestion": "Re-run a snapshot and retry",
        "disposition": NOT_DELIVERED,
        "recovery": {"strategy": error_contract.SNAPSHOT_RECOVERY},
    },
    "APP_NOT_FOUND": {
        "code": "APP_NOT_FOUND",
        "suggestion": "Application name as reported by list-apps",
        "disposition": NOT_DELIVERED,
    },
}


def refusal(error, exit_code=1):
    return Envelope(False, None, error, "{}", 0, [], exit_code)


class EnvelopeVerdictTests(unittest.TestCase):
    def verdicts(self, error=None, exit_code=1, ok=False):
        label, _, code, hint, recovery = error_contract.CASES[1]
        error = dict(FAITHFUL[code], **(error or {}))
        envelope = Envelope(ok, None, error, "{}", 0, [], exit_code)
        return error_contract.envelope_verdict(label, envelope, code, hint, recovery)

    def test_every_case_is_accepted_when_faithful(self):
        for label, _, code, hint, recovery in error_contract.CASES:
            with self.subTest(case=label):
                self.assertEqual(
                    error_contract.envelope_verdict(label, refusal(FAITHFUL[code]), code, hint, recovery), [])

    def test_each_deviation_is_a_problem(self):
        for name, change, expected in (
            ("wrong code", {"code": "ELEMENT_NOT_FOUND"}, "expected SNAPSHOT_NOT_FOUND"),
            ("no suggestion", {"suggestion": ""}, "no suggestion"),
            ("suggestion without the hint", {"suggestion": "try again"}, "does not name"),
            ("delivered", {"disposition": {"delivery": "delivered"}}, "not_delivered"),
            ("no recovery", {"recovery": None}, "recovery strategy"),
        ):
            with self.subTest(name=name):
                problems = self.verdicts(change)
                self.assertTrue(any(expected in problem for problem in problems), problems)

    def test_a_success_envelope_and_a_wrong_exit_are_problems(self):
        self.assertTrue(any("expected SNAPSHOT_NOT_FOUND" in p for p in self.verdicts(ok=True)))
        for exit_code in (0, 2, None):
            with self.subTest(exit_code=exit_code):
                self.assertTrue(any("must exit 1" in p for p in self.verdicts(exit_code=exit_code)))

    def test_cases_cover_the_three_recovery_paths(self):
        self.assertEqual([case[2] for case in error_contract.CASES],
                         ["INVALID_ARGS", "SNAPSHOT_NOT_FOUND", "APP_NOT_FOUND"])
        self.assertEqual(error_contract.CASES[0][1], ["click", "@e1"])


class RestorationTests(unittest.TestCase):
    def run_leg(self, answer):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=None)
        app = SimpleNamespace(windows=["w-calculator"])
        ctx = LegContext(tier, "headless", legs.leg_by_id(LEG), member_reader=lambda _: frozenset())
        calls = []

        def product(tier, argv, **kw):
            calls.append(argv)
            return answer(argv)

        with patch.object(error_contract, "managed") as managed, \
            patch.object(error_contract, "root", return_value=app), \
            patch.object(error_contract, "ref", return_value="@s1:e1"), \
            patch.object(error_contract, "display", return_value=""), \
            patch.object(error_contract, "members", return_value=frozenset()), \
            patch("runner.verdict.run_product", side_effect=product):
            managed.return_value.__enter__.return_value = app
            error_contract.recoverable_error_envelopes(ctx)
        return ctx, calls

    def faithful(self, argv):
        code = next(case[2] for case in error_contract.CASES if case[1] == argv)
        return refusal(FAITHFUL[code])

    def test_faithful_product_restores_and_records_each_oracle_once(self):
        ctx, calls = self.run_leg(self.faithful)
        self.assertEqual(verdict.evaluate(ctx), [])
        self.assertEqual(calls, [case[1] for case in error_contract.CASES])

    def test_a_product_that_accepts_a_bare_ref_fails_the_leg(self):
        def lying(argv):
            if argv == ["click", "@e1"]:
                return Envelope(True, {}, None, "{}", 0, argv, 0)
            return self.faithful(argv)

        with self.assertRaises(AssertionError):
            self.run_leg(lying)

    def test_a_refusal_without_a_suggestion_fails_the_leg(self):
        def mute(argv):
            envelope = self.faithful(argv)
            envelope.error = {key: value for key, value in envelope.error.items() if key != "suggestion"}
            return envelope

        with self.assertRaises(AssertionError):
            self.run_leg(mute)


if __name__ == "__main__":
    unittest.main()
