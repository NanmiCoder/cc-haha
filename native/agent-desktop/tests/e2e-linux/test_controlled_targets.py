import contextlib
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner.product import Envelope
from runner.verdict import LegContext, evaluate
from scenarios import controlled_targets as scenarios


class ControlledTargetTests(unittest.TestCase):
    def test_delayed_dispatch_rejects_missing_or_duplicate_activation(self):
        for activations in (0, 1, 2):
            with self.subTest(activations=activations):
                ctx = LegContext(SimpleNamespace(), "headless", member_reader=lambda _: frozenset())
                state = [False, 0]
                pending = []
                def trigger(delay, action):
                    pending.append(action)
                    return SimpleNamespace(join=lambda: None, cancel=lambda: None)
                def product(*args, **kw):
                    pending.pop()()
                    state[1] += activations
                    return Envelope(True, {}, None, "{}", 0, [])
                with patch.object(scenarios, "delayed", side_effect=trigger), \
                    patch.object(scenarios, "command", side_effect=product), \
                    patch("runner.helper.raw.poll", side_effect=lambda read, *a, **kw: read()):
                    run = lambda: scenarios.delayed_dispatch(ctx, "@s:e1", lambda: tuple(state),
                                                            lambda: state.__setitem__(0, True))
                    if activations == 1:
                        run()
                        self.assertEqual(ctx.reads["atspi.delayed_target"]["after"], [True])
                    else:
                        with self.assertRaises(AssertionError):
                            run()

    def test_seatless_click_rejects_a_lying_success_and_restores_the_display(self):
        for delivers in (False, True):
            with self.subTest(delivers=delivers):
                ctx = LegContext(SimpleNamespace(display=None), "headless",
                                 member_reader=lambda _: frozenset())
                value = [""]
                def command(*args):
                    if delivers:
                        value[0] = "7"
                    return Envelope(True, {}, None, "{}", 0, [])
                with patch("runner.helper.managed", return_value=contextlib.nullcontext(object())), \
                    patch("runner.helper.display", side_effect=lambda _: value[0]), \
                    patch("runner.helper.activate", side_effect=lambda _: value.__setitem__(0, "")), \
                    patch.object(scenarios, "root", return_value=object()), \
                    patch.object(scenarios, "one", return_value=object()), \
                    patch.object(scenarios, "ref", return_value="@s:e1"), \
                    patch.object(scenarios, "command", side_effect=command), \
                    patch("runner.helper.raw.poll", side_effect=lambda read, *a, **kw: read()):
                    if delivers:
                        scenarios.semantic_click_without_seat(ctx)
                        self.assertEqual(evaluate(ctx), [])
                    else:
                        with self.assertRaises(AssertionError):
                            scenarios.semantic_click_without_seat(ctx)
                self.assertEqual(value[0], "")
