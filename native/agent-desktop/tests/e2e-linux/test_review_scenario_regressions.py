import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from runner import legs, verdict, session
from runner.product import Envelope
from runner.verdict import LegContext
from scenarios import lifecycle, text_entry, wayland_actions as wayland


def envelope(argv, data=None, error=None):
    return Envelope(error is None, data, error, "{}", 0, argv)


def context(root, name):
    tier = SimpleNamespace(runtime_dir=Path(root), env={"PATH": "/usr/bin:/bin", "DISPLAY": ":201"})
    return LegContext(tier, "headless", legs.leg_by_id(name), member_reader=lambda _: frozenset())


class ScenarioRegressionTests(unittest.TestCase):
    def test_wayland_windows_are_real_and_bounds_key_is_absent(self):
        for data, count, accepted in (([{"id": "w-1.7-frame"}], 1, True),
                                      ([{"id": "w-1.7-frame", "bounds": None}], 1, False),
                                      ([{"id": "w-1.7-frame"}], 0, False),
                                      ([{"id": "w-1.7-frame"}, {"id": "fake"}], 1, False)):
            with self.subTest(data=data, count=count), tempfile.TemporaryDirectory() as directory:
                ctx = context(directory, "wayland_actions.list_windows_no_position")
                frame = SimpleNamespace(path="/frame", bus=":1.7", role=23, states={"SHOWING"}, children=lambda: [])
                root = SimpleNamespace(children=lambda: [frame] * count)
                with patch.object(wayland, "launch"), patch.object(wayland, "stop"), \
                     patch.object(wayland, "app_root", return_value=root), \
                     patch("runner.verdict.run_product", return_value=envelope([], data)):
                    if accepted:
                        wayland.list_windows_no_position(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])
                    else:
                        with self.assertRaises(AssertionError):
                            wayland.list_windows_no_position(ctx)

    def test_wayland_focus_refusal_reads_focus_and_rejects_a_changed_state(self):
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                ctx = context(directory, "wayland_actions.focus_window_wayland_session_refusal")
                frame = SimpleNamespace(path="/frame", bus=":1.7", role=23, states={"SHOWING"}, children=lambda: [])
                root = SimpleNamespace(children=lambda: [frame])
                def product(tier, argv, **kw):
                    if argv[0] == "list-windows":
                        return envelope(argv, [{"id": "w-1.7-frame"}])
                    if drift:
                        frame.states.add("ACTIVE")
                    return envelope(argv, error={"code": "ACTION_NOT_SUPPORTED", "message": "wayland_session"})
                with patch.object(wayland, "launch"), patch.object(wayland, "stop"), \
                     patch.object(wayland, "app_root", return_value=root), \
                     patch("runner.verdict.run_product", side_effect=product):
                    if drift:
                        with self.assertRaisesRegex(AssertionError, "focus changed"):
                            wayland.focus_window_wayland_session_refusal(ctx)
                    else:
                        wayland.focus_window_wayland_session_refusal(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])

    def test_unhealthy_shell_reaches_client_retries_in_a_valid_private_session(self):
        for leak in (False, True):
            with self.subTest(leak=leak), tempfile.TemporaryDirectory() as directory:
                ctx = context(directory, "wayland_actions.unhealthy_shell_named_reason")
                def run(argv, *, env, **kw):
                    self.assertTrue(Path(argv[1]).is_file())
                    self.assertEqual(env.get("AGENT_DESKTOP_PRIVATE_SESSION"), env["XDG_RUNTIME_DIR"])
                    self.assertNotEqual(env["XDG_RUNTIME_DIR"], str(ctx.tier.runtime_dir))
                    self.assertIn("exit 1", (Path(env["PATH"].split(":")[0]) / "python3").read_text())
                    Path(env["PROBE_STARTS"]).write_text("start\n" * 8)
                    Path(env["PROBE_CLIENTS"]).write_text("client\n" * 8)
                    return subprocess.CompletedProcess(argv, 1, "", "no healthy gnome-shell after 8 starts")
                with patch.object(wayland.subprocess, "run", side_effect=run), \
                     patch.object(session, "_proc_members", side_effect=[[], [(777, 1)] if leak else [], []]), \
                     patch.object(session, "_sweep_members", return_value=[]) as sweep:
                    if leak:
                        with self.assertRaisesRegex(AssertionError, "probe leaked"):
                            wayland.unhealthy_shell_named_reason(ctx)
                    else:
                        wayland.unhealthy_shell_named_reason(ctx)
                        self.assertEqual(verdict.evaluate(ctx), [])
                    sweep.assert_called_once()

    def test_modifier_oracle_checks_connection_query_and_detects_held_shift(self):
        for failure in ("open", "query", "keycode", "held", None):
            with self.subTest(failure=failure):
                lib = Mock()
                lib.XOpenDisplay.return_value = 0 if failure == "open" else 123
                def query(display, keys):
                    if failure == "held":
                        keys[6] = 1 << 2
                    return 0 if failure == "query" else 1
                lib.XQueryKeymap.side_effect = query
                lib.XKeysymToKeycode.return_value = 0 if failure == "keycode" else 50
                tier = SimpleNamespace(env={"DISPLAY": ":201"})
                with patch.object(text_entry.ctypes.util, "find_library", return_value="libX11"), \
                     patch.object(text_entry.ctypes, "CDLL", return_value=lib):
                    if failure in ("open", "query", "keycode"):
                        with self.assertRaises(AssertionError):
                            text_entry._modifier_state(tier)
                    else:
                        state = text_entry.held_modifiers(text_entry._modifier_state(tier))
                        self.assertEqual(bool(state), failure == "held")
                        if failure == "held":
                            self.assertIn("Shift", state)
                if failure != "open":
                    lib.XCloseDisplay.assert_called_once_with(123)

    def test_empty_or_malformed_modifier_state_cannot_mean_released(self):
        for value in ("", "garbage", "Shift:", "Shift: maybe", "Shift: off\nShift: on", "Shift: off"):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                text_entry.held_modifiers(value)
