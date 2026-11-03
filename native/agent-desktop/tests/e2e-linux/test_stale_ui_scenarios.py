import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import observation

LEG = "observation.stale_ref_after_ui_change"
NOT_DELIVERED = {"delivery": "not_delivered", "retry": "safe"}
FAITHFUL = {
    "code": "STALE_REF",
    "suggestion": "Run 'snapshot' to refresh, then retry with the updated ref.",
    "disposition": NOT_DELIVERED,
    "recovery": {"strategy": observation.STALE_RECOVERY},
}


def refusal(error=None, exit_code=1, ok=False):
    return Envelope(ok, None, dict(FAITHFUL, **(error or {})), "{}", 0, [], exit_code)


class StaleVerdictTests(unittest.TestCase):
    def test_a_faithful_stale_refusal_is_accepted(self):
        self.assertEqual(observation.stale_verdict(refusal(), "", ""), [])

    def test_each_deviation_is_a_problem(self):
        for name, envelope, shown, expected in (
            ("wrong code", refusal({"code": "ELEMENT_NOT_FOUND"}), "", "expected STALE_REF"),
            ("success", refusal(ok=True), "", "expected STALE_REF"),
            ("delivered", refusal({"disposition": {"delivery": "delivered"}}), "", "not_delivered"),
            ("no disposition", refusal({"disposition": None}), "", "not_delivered"),
            ("no recovery", refusal({"recovery": None}), "", "recovery strategy"),
            ("wrong recovery", refusal({"recovery": {"strategy": "other"}}), "", "recovery strategy"),
            ("wrong exit", refusal(exit_code=2), "", "must exit 1"),
            ("display changed", refusal(), "7", "changed the display"),
        ):
            with self.subTest(name=name):
                problems = observation.stale_verdict(envelope, "", shown)
                self.assertTrue(any(expected in problem for problem in problems), problems)

    def test_the_expected_code_is_one_exact_value(self):
        self.assertIsInstance(observation.EXPECTED_STALE_CODE, str)
        self.assertEqual(observation.EXPECTED_STALE_CODE, "STALE_REF")


class RestorationTests(unittest.TestCase):
    def run_leg(self, answer, refs=("@s1:e1", "@s2:e1")):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=None)
        app = SimpleNamespace(windows=["w-calculator"], owner_names=[":1.9"])
        ctx = LegContext(tier, "headless", legs.leg_by_id(LEG), member_reader=lambda _: frozenset())
        calls = []
        members = []

        @contextmanager
        def managed(*args):
            members.append((123, 99, "Calculator"))
            try:
                yield app
            finally:
                members.clear()

        def product(tier, argv, **kw):
            calls.append(argv)
            return answer(argv)

        with patch.object(observation, "managed", side_effect=managed), \
            patch.object(observation, "root", return_value=app), \
            patch.object(observation, "display", return_value=""), \
            patch.object(observation, "members", side_effect=lambda _: list(members)), \
            patch.object(observation, "prepare_about", side_effect=list(refs)), \
            patch.object(observation, "close_main_menu"), \
            patch("runner.verdict.run_product", side_effect=product):
            observation.stale_ref_after_ui_change(ctx)
        return ctx, calls

    def test_faithful_product_restores_and_records_each_oracle_once(self):
        ctx, calls = self.run_leg(lambda argv: refusal())
        self.assertEqual(verdict.evaluate(ctx), [])
        self.assertEqual(calls, [["click", "@s1:e1", "--timeout-ms", "0"]])

    def test_a_product_that_clicks_the_closed_menu_item_fails_the_leg(self):
        with self.assertRaises(AssertionError):
            self.run_leg(lambda argv: Envelope(True, {}, None, "{}", 0, argv, 0))

    def test_a_refusal_without_recovery_fails_the_leg(self):
        with self.assertRaises(AssertionError):
            self.run_leg(lambda argv: refusal({"recovery": None}))

    def test_a_fresh_snapshot_that_reuses_the_ref_fails_the_leg(self):
        with self.assertRaises(AssertionError):
            self.run_leg(lambda argv: refusal(), refs=("@s1:e1", "@s1:e1"))

    def test_the_app_ending_fails_the_leg(self):
        reads = iter([frozenset({(1, 1)}), frozenset()])
        tier = SimpleNamespace(runtime_dir=Path("/private/test"), display=None)
        app = SimpleNamespace(windows=["w-calculator"], owner_names=[":1.9"])
        ctx = LegContext(tier, "headless", legs.leg_by_id(LEG), member_reader=lambda _: frozenset())
        with patch.object(observation, "managed") as managed, \
            patch.object(observation, "root", return_value=app), \
            patch.object(observation, "display", return_value=""), \
            patch.object(observation, "members", side_effect=lambda _: next(reads)), \
            patch.object(observation, "prepare_about", return_value="@s1:e1"), \
            patch.object(observation, "close_main_menu"), \
            patch("runner.verdict.run_product", side_effect=lambda t, argv, **kw: refusal()):
            managed.return_value.__enter__.return_value = app
            with self.assertRaises(AssertionError):
                observation.stale_ref_after_ui_change(ctx)


if __name__ == "__main__":
    unittest.main()
