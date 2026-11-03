import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from runner import legs, verdict
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import launch


class LaunchScenarioTests(unittest.TestCase):
    def test_alias_queries_require_the_independently_launched_calculator(self):
        calculator = {"name": "gnome-calculator", "pid": 123}
        for bad in (None, [], [{"name": "gnome-text-editor", "pid": 456}],
                    [{"name": "gnome-calculator", "pid": 456}],
                    [{"name": "gnome-text-editor", "pid": 123}],
                    [calculator, {"name": "gnome-text-editor", "pid": 456}]):
            for query in (0, 1, "both"):
                with self.subTest(bad=bad, query=query):
                    tier = SimpleNamespace(runtime_dir=Path("/private/test"))
                    ctx = LegContext(tier, "headless", legs.leg_by_id("launch.list_apps_alias"),
                                     member_reader=lambda _: frozenset())
                    calls = []
                    def product(tier, argv, **kw):
                        rows = bad if bad is not None and query in (len(calls), "both") else [calculator]
                        calls.append(argv)
                        return Envelope(True, {"apps": rows}, None, str(rows), 0, argv)
                    root = SimpleNamespace(name="gnome-calculator")
                    with patch.object(launch, "launch", return_value=SimpleNamespace(pid=123)), \
                         patch.object(launch, "stop"), \
                         patch.object(launch, "registry", return_value=[root]), \
                         patch.object(launch, "app_root", return_value=root), \
                         patch("runner.verdict.run_product", side_effect=product):
                        if bad is None:
                            launch.list_apps_alias(ctx)
                            self.assertEqual(verdict.evaluate(ctx), [])
                            self.assertEqual([argv[-1] for argv in calls], ["Calculator", "calculator"])
                        else:
                            with self.assertRaises(AssertionError):
                                launch.list_apps_alias(ctx)
