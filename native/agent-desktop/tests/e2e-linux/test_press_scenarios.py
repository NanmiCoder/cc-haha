import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import headed_actions, lifecycle, text_entry

LEG = "text_entry.press_combos_edit_document"
ALL_OFF = "Shift: off\nControl: off\nAlt: off\nSuper: off"


class PressVerdictTests(unittest.TestCase):
    def test_a_faithful_run_is_accepted(self):
        self.assertEqual(text_entry.press_verdict("ab", "ab\n", "", []), [])
        self.assertEqual(text_entry.press_verdict("x\nab", "x\nab\n", "", []), [])

    def test_each_failure_is_one_named_problem(self):
        for name, args, expected in (
            ("type missing", ("", "\n", "", []), "semantic type did not reach"),
            ("no newline", ("ab", "ab", "", []), "exactly one newline"),
            ("two newlines", ("ab", "ab\n\n", "", []), "exactly one newline"),
            ("not cleared", ("ab", "ab\n", "ab\n", []), "left 'ab\\n'"),
            ("stuck modifier", ("ab", "ab\n", "", ["Control"]), "modifiers left down: ['Control']"),
        ):
            with self.subTest(name=name):
                problems = text_entry.press_verdict(*args)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(expected, problems[0])


class RestorationTests(unittest.TestCase):
    def run_leg(self, original, backspace_works=True):
        tier = SimpleNamespace(runtime_dir=Path("/private/test"))
        app = SimpleNamespace(windows=["w-editor"])
        document, selected = [original], [False]
        ctx = LegContext(tier, "headed", legs.leg_by_id(LEG), member_reader=lambda _: frozenset())

        def product(tier, argv, **kw):
            if argv[0] == "type":
                document[0] += argv[-1]
            elif argv[0] == "clear":
                document[0] = ""
            elif argv[:2] == ["press", "return"]:
                document[0] += "\n"
            elif argv[:2] == ["press", "ctrl+a"]:
                selected[0] = True
            elif argv[:2] == ["press", "backspace"] and backspace_works and selected[0]:
                document[0], selected[0] = "", False
            return Envelope(True, {}, None, "{}", 0, argv)

        with patch.object(lifecycle.apps, "launch", return_value=app), \
            patch.object(lifecycle.apps, "stop"), \
            patch.object(headed_actions, "ref_for", return_value="@s:e1"), \
            patch.object(text_entry, "ref_for", return_value="@s:e1"), \
            patch.object(headed_actions, "live_root", return_value=app), \
            patch.object(text_entry, "live_root", return_value=app), \
            patch.object(headed_actions, "longest_text", side_effect=lambda _: document[0]), \
            patch.object(text_entry, "longest_text", side_effect=lambda _: document[0]), \
            patch.object(text_entry, "_modifier_state", return_value=ALL_OFF), \
            patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read, *a, **kw: read()), \
            patch("runner.verdict.run_product", side_effect=product):
            text_entry.press_combos_edit_document(ctx)
        return ctx, document

    def test_faithful_product_restores_the_document_and_records_each_oracle_once(self):
        for original in ("", "saved"):
            with self.subTest(original=original):
                ctx, document = self.run_leg(original)
                self.assertEqual(verdict.evaluate(ctx), [])
                self.assertEqual(document[0], original)

    def test_a_backspace_that_deletes_nothing_fails_the_leg(self):
        with self.assertRaises(AssertionError):
            self.run_leg("", backspace_works=False)


if __name__ == "__main__":
    unittest.main()
