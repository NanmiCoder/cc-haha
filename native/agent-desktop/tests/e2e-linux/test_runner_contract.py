from __future__ import annotations

import contextlib
import importlib
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from runner import gate, legs, main, report
from runner.legs import REGISTRY, Leg


def contract_violations(registry, implementations):
    problems = []
    ids = {leg.id for leg in registry}
    for leg_id in sorted(ids - set(implementations)):
        problems.append(f"no implementation registered for {leg_id}")
    for leg_id in sorted(set(implementations) - ids):
        problems.append(f"implementation registered for unregistered leg {leg_id}")
    return problems


def make_binary(root: Path, body: str) -> Path:
    path = Path(root) / "fake-agent-desktop"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o700)
    helper = root / "agent-desktop-linux-clipboard-owner"
    helper.write_text("#!/bin/sh\necho clipboard-owner\n")
    helper.chmod(0o700)
    return path


class RegistryContractTests(unittest.TestCase):
    def test_every_registry_leg_has_an_implementation(self):
        importlib.import_module("scenarios")
        self.assertTrue(REGISTRY)
        self.assertTrue(legs.implementations())
        problems = contract_violations(REGISTRY, legs.implementations())
        self.assertEqual(problems, [])

    def test_unimplemented_record_is_a_violation(self):
        problems = contract_violations(REGISTRY[:1], {})
        self.assertEqual(len(problems), 1)
        self.assertIn("no implementation", problems[0])

    def test_unregistered_implementation_is_a_violation(self):
        problems = contract_violations(
            REGISTRY[:1], {REGISTRY[0].id: lambda ctx: None, "phantom.id": lambda ctx: None}
        )
        self.assertTrue(any("unregistered leg phantom.id" in p for p in problems))

    def test_record_with_no_requirement_fails_construction(self):
        with self.assertRaises(ValueError):
            Leg(
                id="x.y",
                requirement="  ",
                target="t",
                tiers=("x11-openbox",),
                modes=("headless",),
                oracles=("atspi",),
                disposition="pass",
            )

    def test_owner_decision_without_a_reason_fails_construction(self):
        fields = dict(
            id="owner.case",
            requirement="r",
            target="t",
            tiers=("x11-openbox",),
            modes=("headless",),
            oracles=("atspi",),
            disposition="owner-decision",
        )
        with self.assertRaises(ValueError):
            Leg(reason="", **fields)
        leg = Leg(reason="the owner chose this", **fields)
        self.assertEqual(leg.disposition, "owner-decision")


class GateTests(unittest.TestCase):
    def test_gate_fails_off_linux(self):
        missing = gate.check_prerequisites(platform="darwin")
        self.assertEqual(missing, ["a linux host is required for the live harness"])

    def test_missing_tool_is_named(self):
        with tempfile.TemporaryDirectory() as root:
            env = {
                "AGENT_DESKTOP_SESSION_BASE": str(Path(root) / "sessions"),
                "AGENT_DESKTOP_E2E_BIN": str(make_binary(Path(root), "exit 0")),
                "AGENT_DESKTOP_WM_ROOT": str(Path(root) / "wm"),
            }
            (Path(env["AGENT_DESKTOP_WM_ROOT"]) / "usr" / "bin").mkdir(parents=True)
            (Path(env["AGENT_DESKTOP_WM_ROOT"]) / "usr" / "bin" / "openbox").write_text("x")
            missing = gate.check_prerequisites(
                ("x11-openbox",),
                which=lambda tool: None,
                env=env,
                extra_paths=(),
                gi_probe=lambda: None,
                platform="linux",
            )
        self.assertTrue(any("missing tool: Xvfb" in m for m in missing))
        self.assertTrue(any("xdotool" in m for m in missing))

    def test_all_tools_found_passes(self):
        with tempfile.TemporaryDirectory() as root:
            wm = Path(root) / "wm" / "usr" / "bin"
            wm.mkdir(parents=True)
            (wm / "openbox").write_text("x")
            env = {
                "AGENT_DESKTOP_SESSION_BASE": str(Path(root) / "sessions"),
                "AGENT_DESKTOP_E2E_BIN": str(make_binary(Path(root), "exit 0")),
                "AGENT_DESKTOP_WM_ROOT": str(Path(root) / "wm"),
            }
            for key in ("AGENT_DESKTOP_E2E_BIN", "AGENT_DESKTOP_E2E_BIN_SRC"):
                with self.subTest(key=key):
                    selected = {name: value for name, value in env.items()
                                if name != "AGENT_DESKTOP_E2E_BIN"}
                    selected[key] = env["AGENT_DESKTOP_E2E_BIN"]
                    missing = gate.check_prerequisites(
                        ("x11-openbox",),
                        which=lambda tool: f"/usr/bin/{tool}",
                        env=selected,
                        extra_paths=(),
                        gi_probe=lambda: None,
                        platform="linux",
                    )
                    self.assertEqual(missing, [])

    def test_session_base_defaults_and_overrides(self):
        cases = (
            ({}, Path("/tmp/agent-desktop-sessions-1234")),
            ({"XDG_RUNTIME_DIR": ""}, Path("/tmp/agent-desktop-sessions-1234")),
            ({"AGENT_DESKTOP_SESSION_BASE": ""}, Path("/tmp/agent-desktop-sessions-1234")),
            ({"XDG_RUNTIME_DIR": "/runtime"}, Path("/runtime/agent-desktop-sessions")),
            ({"AGENT_DESKTOP_SESSION_BASE": "", "XDG_RUNTIME_DIR": "/runtime"},
             Path("/runtime/agent-desktop-sessions")),
            ({"AGENT_DESKTOP_SESSION_BASE": "/custom", "XDG_RUNTIME_DIR": "/runtime"},
             Path("/custom")),
            ({"AGENT_DESKTOP_SESSION_BASE": "/custom"}, Path("/custom")),
        )
        for env, expected in cases:
            with self.subTest(env=env), mock.patch.object(Path, "mkdir", autospec=True) as mkdir, \
                    mock.patch.object(os, "getuid", return_value=1234):
                gate.check_prerequisites(
                    ("x11-mutter",), env=env, platform="linux",
                    which=lambda tool: f"/usr/bin/{tool}", gi_probe=lambda: None,
                )
                mkdir.assert_called_once_with(expected, mode=0o700, parents=True, exist_ok=True)

    def test_run_without_interaction_lease_exits_two_before_the_gate(self):
        environment = {name: value for name, value in os.environ.items()
                       if name not in (main.LOCK_ROOT_ENV, main.LEASE_FD_ENV)}
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, environment, clear=True), \
            mock.patch.object(gate, "check_prerequisites",
                              side_effect=AssertionError("the gate ran without a lease")), \
            contextlib.redirect_stderr(stderr):
            code = main.main(["--tier", "x11-openbox"])
        self.assertEqual(code, 2)
        self.assertEqual(stderr.getvalue().strip(),
                         "gate: run through run.sh so the interaction lease is held")

    def test_incompatible_leg_and_tier_is_rejected_before_startup(self):
        with mock.patch.object(main, "_acquire_lease", return_value=None), \
            mock.patch.object(gate, "check_prerequisites", side_effect=AssertionError("invalid selection reached startup")):
            self.assertEqual(main.main([
                "--tier", "wayland", "--leg", "state.terminal_copy_follows_selection"]), 2)


class ReportTests(unittest.TestCase):
    def test_exit_code_mapping(self):
        self.assertEqual(report.exit_code(0, False), 0)
        self.assertEqual(report.exit_code(3, False), 1)
        self.assertEqual(report.exit_code(0, True), 2)
        self.assertEqual(report.exit_code(3, True), 2)

    def test_failure_counts(self):
        outcomes = [
            report.LegOutcome("a", "x11-openbox", "headless", report.PASS),
            report.LegOutcome("b", "x11-openbox", "headless", report.BLOCKED),
            report.LegOutcome("c", "x11-openbox", "headless", report.FAIL),
            report.LegOutcome("d", "x11-openbox", "headless", report.ERROR),
            report.LegOutcome("e", "x11-openbox", "headless", report.UNIMPLEMENTED),
            report.LegOutcome("f", "x11-openbox", "headless", report.TIER_UNAVAILABLE),
            report.LegOutcome("g", "x11-openbox", "headless", report.OUTSTANDING),
        ]
        self.assertEqual(report.count_failures(outcomes), 6)

    def test_only_passed_or_asserted_refusal_legs_exit_zero(self):
        accepted = [
            report.LegOutcome("a", "x11-openbox", "headless", report.PASS),
            report.LegOutcome("b", "x11-openbox", "headless", report.REFUSED),
        ]
        self.assertEqual(report.count_failures(accepted), 0)
        self.assertEqual(report.exit_code(report.count_failures(accepted), False), 0)
        for rejected in (report.OWNER, report.BLOCKED, report.OUTSTANDING, report.FAIL):
            outcomes = accepted + [
                report.LegOutcome("z", "x11-openbox", "headless", rejected)
            ]
            self.assertEqual(report.exit_code(report.count_failures(outcomes), False), 1)

    def test_render_groups_by_tier_and_mode(self):
        outcomes = [
            report.LegOutcome("a", "x11-openbox", "headless", report.PASS),
            report.LegOutcome("b", "wayland", "headed", report.FAIL, detail="no read"),
        ]
        text = report.render(outcomes)
        self.assertIn("tier x11-openbox", text)
        self.assertIn("tier wayland", text)
        self.assertIn("headed", text)
        self.assertIn("a", text)
        self.assertIn("summary:", text)

    def test_parse_args_flags(self):
        args = main.parse_args(["--tier", "wayland", "--leg", "x.y", "--lying-actions"])
        self.assertEqual(args.tier, "wayland")
        self.assertEqual(args.leg, "x.y")
        self.assertTrue(args.lying_actions)





if __name__ == "__main__":
    unittest.main()
