from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from runner import verdict
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


class RepeatedReadTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.tier = fake_tier(Path(self.root.name))

    def ctx(self, leg=None) -> LegContext:
        return LegContext(self.tier, "headless", leg, member_reader=lambda tier: frozenset())

    def test_each_observation_key_needs_one_before_after_and_final_read(self):
        for stages in (
            {"before": [0], "after": [0, 1], "restored": [0]},
            {"before": [0, 1], "after": [0], "restored": [0]},
            {"before": [0], "after": [0]},
            {"before": [0], "after": [1], "restored": [0, 0]},
        ):
            with self.subTest(stages=stages):
                ctx = self.ctx()
                for stage, values in stages.items():
                    for value in values:
                        getattr(ctx, stage)("atspi.display", value)
                self.assertTrue(verdict.evaluate(ctx))

    def test_restoration_must_be_read_after_the_effect(self):
        ctx = self.ctx()
        ctx.before("atspi.display", 0)
        ctx.restored("atspi.display", 0)
        ctx.after("atspi.display", 1)
        self.assertTrue(verdict.evaluate(ctx))

    def test_restoration_matches_its_own_key_not_another_baseline(self):
        ctx = self.ctx()
        for stage, first, second in (("before", 0, 1), ("after", 2, 3), ("restored", 1, 0)):
            getattr(ctx, stage)("atspi.first", first)
            getattr(ctx, stage)("atspi.second", second)
        self.assertTrue(verdict.evaluate(ctx))

    def test_a_mutable_observation_cannot_rewrite_its_baseline(self):
        ctx = self.ctx()
        value = {"state": 0}
        ctx.before("atspi.state", value)
        value["state"] = 1
        ctx.after("atspi.state", value)
        ctx.restored("atspi.state", value)
        self.assertTrue(verdict.evaluate(ctx))

    def test_independent_keyed_reads_accept_none_tuples_and_dicts(self):
        ctx = self.ctx()
        for key, value in (("empty", None), ("window", ("a", (1, 2))), ("state", {"window": (3, 4)})):
            for stage in ("before", "after", "restored"):
                getattr(ctx, stage)("atspi." + key, value)
        self.assertEqual(verdict.evaluate(ctx), [])


if __name__ == "__main__":
    unittest.main()
