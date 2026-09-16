#!/usr/bin/env python3
"""Tests for win_helper.py.

macOS routes every Computer Use command to the signed native `cu-helper`
daemon — `helperBridge` refuses to fall back to Python — so `mac_helper.py`
was unreachable and has been deleted. This file therefore covers the Windows
helper only.

Most tests here are static (they read the source) rather than executed,
because the runtime deps (pywin32, pyautogui, mss) are Windows-only and CI
runs on macOS. Static coverage is enough for what actually regresses: the
guards getting dropped, inverted, or quietly bypassed.

Usage:
    python -m pytest runtime/test_helpers.py -v
    python runtime/test_helpers.py
"""
from __future__ import annotations

import ast
import importlib.util
import json
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace

IS_WINDOWS = sys.platform == "win32"

RUNTIME_DIR = Path(__file__).parent
WIN_HELPER = RUNTIME_DIR / "win_helper.py"
CURSOR_BADGE = RUNTIME_DIR / "win_cursor_badge.py"


def _win_source() -> str:
    return WIN_HELPER.read_text(encoding="utf-8")


class TestKeyMap(unittest.TestCase):
    """KEY_MAP translates macOS key names to Windows ones."""

    def _load_key_map(self, helper_path: Path) -> dict[str, str]:
        source = helper_path.read_text(encoding="utf-8")
        start = source.index("KEY_MAP = {")
        depth = 0
        for i, ch in enumerate(source[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        ns: dict = {}
        exec(source[start:end], ns)
        return ns["KEY_MAP"]

    def test_win_key_map_exists(self):
        km = self._load_key_map(WIN_HELPER)
        self.assertIn("cmd", km)
        self.assertIn("ctrl", km)
        # The mapping that matters: a model trained on macOS emits "cmd", and
        # on Windows that has to become "win", not silently stay "cmd".
        self.assertEqual(km["cmd"], "win")

    def test_all_alphabet_keys(self):
        km = self._load_key_map(WIN_HELPER)
        for ch in "abcdefghijklmnopqrstuvwxyz":
            self.assertIn(ch, km)

    def test_all_digit_keys(self):
        km = self._load_key_map(WIN_HELPER)
        for d in "0123456789":
            self.assertIn(d, km)


class TestJSONProtocol(unittest.TestCase):
    def _parse_main_commands(self, helper_path: Path) -> list[str]:
        source = helper_path.read_text(encoding="utf-8")
        commands = []
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith('if command == "'):
                commands.append(stripped.split('"')[1])
        return commands

    def test_expected_commands_exist(self):
        expected = {
            "check_permissions", "list_displays", "get_display_size",
            "screenshot", "resolve_prepare_capture", "zoom",
            "prepare_for_action", "preview_hide_set", "find_window_displays",
            "key", "hold_key", "type", "click", "drag",
            "move_mouse", "scroll", "mouse_down", "mouse_up",
            "cursor_position", "frontmost_app", "app_under_point",
            "list_installed_apps", "list_running_apps", "open_app",
            "read_clipboard", "write_clipboard", "paste_clipboard",
        }
        cmds = set(self._parse_main_commands(WIN_HELPER))
        self.assertFalse(expected - cmds,
                         f"win_helper.py missing commands: {expected - cmds}")

    @unittest.skipUnless(IS_WINDOWS, "requires Windows runtime deps")
    def test_unknown_command_returns_error(self):
        result = subprocess.run(
            [sys.executable, str(WIN_HELPER), "nonexistent_command_xyz"],
            capture_output=True, text=True,
        )
        if result.returncode == 1 and not result.stdout.strip():
            self.skipTest("missing platform deps")
        self.assertEqual(result.returncode, 2)
        parsed = json.loads(result.stdout.strip())
        self.assertFalse(parsed["ok"])
        self.assertEqual(parsed["error"]["code"], "bad_command")


@unittest.skipUnless(IS_WINDOWS, "requires Windows runtime deps")
class TestWindowsApplicationDiscovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("win_helper_app_discovery", WIN_HELPER)
        assert spec is not None and spec.loader is not None
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_installed_apps_adds_a_visible_app_missing_from_uninstall_registry(self):
        visible = [{
            "bundleId": "Notepad",
            "displayName": "Notepad.exe",
            "path": r"C:\Windows\System32\notepad.exe",
        }]
        with patch.object(self.module, "_visible_gui_apps", return_value=visible):
            apps = self.module.installed_apps()
        self.assertEqual(
            [app for app in apps if app["bundleId"] == "Notepad"],
            visible,
        )

    def test_running_apps_uses_visible_window_inventory(self):
        visible = [{
            "bundleId": "CalculatorApp",
            "displayName": "CalculatorApp.exe",
            "path": r"C:\Program Files\WindowsApps\CalculatorApp.exe",
        }]
        with patch.object(self.module, "_visible_gui_apps", return_value=visible):
            self.assertEqual(self.module.running_apps(), [{
                "bundleId": "CalculatorApp",
                "displayName": "CalculatorApp.exe",
            }])

    def test_open_app_foregrounds_a_running_app_instead_of_launching_another(self):
        with (
            patch.object(self.module, "_foreground_existing_app", return_value=True),
            patch.object(self.module.subprocess, "Popen") as popen,
        ):
            self.module.open_app("Notepad")
        popen.assert_not_called()

    def test_type_text_paces_long_input_inside_one_helper_call(self):
        with (
            patch.object(self.module, "_send_inputs") as send_inputs,
            patch.object(self.module.time, "sleep"),
        ):
            self.module.type_text("A" * 130 + "\r\nB\tC")

        # One paced SendInput call per character plus Return and Tab. The
        # complete string still stays inside this single Python invocation
        # instead of spawning a helper process for every grapheme.
        self.assertEqual(send_inputs.call_count, 134)
        self.assertTrue(all(
            len(call.args[0]) == 2
            for call in send_inputs.call_args_list
        ))

    def test_application_frame_window_resolves_to_packaged_child_process(self):
        host = SimpleNamespace(
            name=lambda: "ApplicationFrameHost.exe",
            exe=lambda: r"C:\Windows\System32\ApplicationFrameHost.exe",
            pid=10,
        )
        calculator = SimpleNamespace(
            name=lambda: "CalculatorApp.exe",
            exe=lambda: r"C:\Program Files\WindowsApps\CalculatorApp.exe",
            pid=20,
        )

        def enum_children(_hwnd, callback, context):
            callback(200, context)

        with (
            patch("win32process.GetWindowThreadProcessId", side_effect=[(0, 10), (0, 20)]),
            patch("win32gui.EnumChildWindows", side_effect=enum_children),
            patch("win32gui.GetClassName", return_value="Windows.UI.Core.CoreWindow"),
            patch("psutil.Process", side_effect=[host, calculator]),
        ):
            resolved = self.module._window_process(100)

        self.assertEqual(resolved.name(), "CalculatorApp.exe")


class TestMutatingCommandsAreGuarded(unittest.TestCase):
    """Every command that injects input must pass through the guards.

    These are static-source tests on purpose. The failure being guarded against
    is someone adding an eleventh mutating verb and wiring it like the ten that
    came before — at which point it silently has no lease and no reachability
    check. A runtime test would need Windows and would only cover the verbs it
    thought to enumerate; reading the dispatcher catches the new one.
    """

    # Kept as a literal, deliberately duplicating MUTATING_COMMANDS in the
    # helper. If the two drift the test fails, which is the point: the set is
    # a security boundary and should not be edited casually on one side only.
    MUTATING = {
        "click", "drag", "move_mouse", "scroll",
        "mouse_down", "mouse_up",
        "key", "hold_key", "type",
        "paste_clipboard",
    }

    def _module_constant(self, name: str) -> set[str]:
        """Read a module-level frozenset/set constant without importing."""
        tree = ast.parse(_win_source())
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == name:
                        return set(ast.literal_eval(
                            node.value.args[0]
                            if isinstance(node.value, ast.Call)
                            else node.value
                        ))
        raise AssertionError(f"{name} not found in win_helper.py")

    def test_mutating_command_set_matches_this_test(self):
        self.assertEqual(self._module_constant("MUTATING_COMMANDS"), self.MUTATING)

    def test_coordinate_commands_are_a_subset(self):
        coords = self._module_constant("COORDINATE_COMMANDS")
        self.assertTrue(coords <= self.MUTATING)
        # `key`/`type` go wherever focus is and have no point to validate.
        # Asserting their absence keeps someone from "fixing" the coordinate
        # guard by adding them and then dereferencing an x/y that isn't there.
        self.assertNotIn("key", coords)
        self.assertNotIn("type", coords)

    def test_pointer_motion_uses_the_animation_gate(self):
        """Coordinate actions must not jump while mouse animation is enabled."""
        source = _win_source()
        self.assertIn("def _move_cursor_to", source)
        self.assertIn("def _spring_cursor_path", source)
        self.assertNotIn("1 - (1 - progress) ** 3", source)
        dispatcher = source.index("def main()")
        for command in ("click", "drag", "move_mouse", "scroll"):
            marker = f'if command == "{command}":'
            start = source.index(marker, dispatcher)
            body = source[start:start + 1400]
            self.assertIn(
                'payload.get("animate", True)',
                body,
                f"{command} must honor the mouse-animation gate",
            )

    @unittest.skipUnless(IS_WINDOWS, "requires the Windows helper module")
    def test_spring_cursor_path_starts_smoothly_and_lands_exactly(self):
        spec = importlib.util.spec_from_file_location("win_helper_motion", WIN_HELPER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        points = module._spring_cursor_path(0, 0, 1000, 500)
        self.assertGreater(len(points), 12)
        self.assertEqual(points[-1], (1000, 500))
        first_distance = (points[0][0] ** 2 + points[0][1] ** 2) ** 0.5
        total_distance = (1000 ** 2 + 500 ** 2) ** 0.5
        self.assertLess(first_distance / total_distance, 0.10)
        self.assertTrue(all(a != b for a, b in zip(points, points[1:])))

    def test_drag_reuses_the_shared_cursor_motion(self):
        source = _win_source()
        dispatcher = source.index('if command == "drag":')
        body = source[dispatcher:source.index('if command == "move_mouse":', dispatcher)]
        self.assertGreaterEqual(body.count("_move_cursor_to("), 2)
        self.assertNotIn("for step in range", body)

    def test_helper_uses_per_monitor_dpi_coordinates(self):
        source = _win_source()
        self.assertIn("DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2", source)
        self.assertIn("SetProcessDpiAwarenessContext", source)
        self.assertIn("GetDpiForMonitor", source)

    def test_every_mutating_branch_finalizes_the_lease(self):
        """No mutating branch may answer with a bare json_output.

        This is the specific regression: `_finish` is what runs the post-action
        interference check, so a branch that writes its own success response
        reports "Action completed" for input that may have collided with the
        user's own typing.
        """
        source = _win_source()
        start = source.index('    try:\n        command = args.command')
        end = source.index('        error_output(f"Unknown command: {command}"')
        dispatcher = source[start:end]

        blocks = dispatcher.split('if command == "')
        for block in blocks[1:]:
            name = block.split('"')[0]
            if name not in self.MUTATING:
                continue
            body = block.split("if command ==")[0]
            self.assertIn(
                "_finish(lease,", body,
                f'"{name}" must return through _finish so the lease is checked',
            )
            self.assertNotIn(
                'json_output({"ok": True', body,
                f'"{name}" writes its own success response, bypassing the lease',
            )

    def test_guards_run_before_any_injection(self):
        """acquire() must precede the dispatch chain, not follow it."""
        source = _win_source()
        acquire = source.index("lease.acquire()")
        first_branch = source.index('        if command == "check_permissions"')
        self.assertLess(
            acquire, first_branch,
            "the lease must be acquired before any command branch runs",
        )


class TestInterferenceDetection(unittest.TestCase):
    def test_uses_injected_flags_to_separate_agent_and_physical_input(self):
        """The detector must observe origin, not infer it from a timestamp."""
        source = _win_source()
        self.assertIn("SetWindowsHookExW", source)
        self.assertIn("LLKHF_INJECTED", source)
        self.assertIn("LLMHF_INJECTED", source)
        self.assertIn("dwExtraInfo", source)
        self.assertIn("SendInput", source)

    def test_distinguishes_did_not_run_from_outcome_unknown(self):
        """The two interference verdicts must stay distinct.

        Collapsing them is a real hazard: `user_interference` means nothing
        happened and a retry is safe, while `user_interference_result_unknown`
        means input already went out and a retry could double-apply it. On a
        play/pause toggle those differ by exactly one wrong outcome.
        """
        source = _win_source()
        self.assertIn('"user_interference"', source)
        self.assertIn('user_interference_result_unknown', source)

        acquire_start = source.index("    def acquire(self)")
        acquire_body = source[acquire_start:source.index("    def finalize(self)")]
        self.assertNotIn("result_unknown", acquire_body,
                         "a pre-action refusal means nothing ran; the outcome is known")

        finalize_body = source[source.index("    def finalize(self)"):]
        finalize_body = finalize_body[:finalize_body.index("\n\n\n")]
        self.assertIn("result_unknown", finalize_body,
                      "post-action interference leaves the outcome unknown")

    def test_monitor_failure_refuses_before_injection(self):
        """An unavailable safety monitor must fail closed before input."""
        source = _win_source()
        self.assertIn('code = "input_monitor_unavailable"', source)
        self.assertIn("InputMonitorUnavailable,", source)
        self.assertLess(
            source.index("lease.acquire()"),
            source.index('if command == "check_permissions"'),
        )

    @unittest.skipUnless(IS_WINDOWS, "requires Windows input injection")
    def test_tagged_keyboard_and_mouse_input_do_not_trip_the_detector(self):
        spec = importlib.util.spec_from_file_location("win_helper", WIN_HELPER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        lease = module.ForegroundLease("key")
        lease.acquire()
        try:
            module.key_action("shift")
            module._send_inputs([
                module._mouse_input(
                    module.MOUSEEVENTF_MOVE
                    | module.MOUSEEVENTF_MOVE_NOCOALESCE,
                    dx=1,
                ),
                module._mouse_input(
                    module.MOUSEEVENTF_MOVE
                    | module.MOUSEEVENTF_MOVE_NOCOALESCE,
                    dx=-1,
                ),
            ])
            lease.finalize()
            self.assertGreaterEqual(lease.monitor.agent_count, 4)
            self.assertEqual(lease.monitor.interference_count, 0)
        finally:
            close = getattr(lease, "close", None)
            if close is not None:
                close()

    @unittest.skipUnless(IS_WINDOWS, "requires Windows input injection")
    def test_foreign_injected_input_is_interference(self):
        spec = importlib.util.spec_from_file_location("win_helper", WIN_HELPER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        monitor = module.PhysicalInputMonitor()
        monitor.start()
        try:
            before = monitor.snapshot()
            module.ctypes.windll.user32.mouse_event(
                module.MOUSEEVENTF_MOVE, 1, 0, 0, 0
            )
            module.ctypes.windll.user32.mouse_event(
                module.MOUSEEVENTF_MOVE, -1, 0, 0, 0
            )
            after = monitor.snapshot()
            self.assertGreater(after, before)
            self.assertEqual(monitor.agent_count, 0)
        finally:
            monitor.stop()


class TestDeliveryGuards(unittest.TestCase):
    def test_offscreen_point_is_refused(self):
        source = _win_source()
        self.assertIn("point_outside_display", source)
        self.assertIn("def ensure_point_on_screen", source)

    def test_unreachable_window_is_refused(self):
        source = _win_source()
        self.assertIn("target_window_offscreen", source)
        self.assertIn("def ensure_target_window_reachable", source)

    def test_reachability_check_sees_minimized_windows(self):
        """It must NOT reuse list_windows().

        `list_windows()` filters out invisible and zero-area windows — exactly
        the states the guard needs to observe in order to refuse. An earlier
        draft of this guard did reuse it, matched nothing, and passed
        everything. The enumeration has to be its own.
        """
        tree = ast.parse(_win_source())
        fn = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_windows_for_bundle"
        )
        # Walk the AST rather than the text, so the explanatory docstring
        # (which names list_windows to say why it is NOT used) cannot satisfy
        # or break the assertion.
        called = {
            n.func.id for n in ast.walk(fn)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
        }
        self.assertNotIn("list_windows", called)

        source = _win_source()
        body = source[source.index("def _windows_for_bundle"):
                      source.index("def ensure_target_window_reachable")]
        self.assertIn("EnumWindows", body)
        self.assertIn("SW_SHOWMINIMIZED", source)

    def test_refusals_carry_a_machine_readable_code(self):
        source = _win_source()
        self.assertIn("class DeliveryRefused", source)
        self.assertIn("error_output(str(exc), code=exc.code)", source)

    def test_refusal_says_the_action_was_not_sent(self):
        """The message must state that nothing happened.

        "Could not reach the window" reads like a warning attached to an action
        that still went out. The model needs to know the action did not happen,
        or it will assume it did and move on.
        """
        source = _win_source()
        self.assertIn("was NOT sent", source)


class TestCursorBadge(unittest.TestCase):
    """Windows renders the same virtual-cursor language as macOS."""

    def test_badge_script_exists(self):
        self.assertTrue(CURSOR_BADGE.exists())

    def test_badge_is_click_through_and_never_takes_focus(self):
        """Any of these missing turns the badge into an obstacle.

        Without WS_EX_TRANSPARENT it eats the clicks it is meant to describe;
        without WS_EX_NOACTIVATE it steals focus from the app being driven —
        which would break the very action it is annotating.
        """
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        tree = ast.parse(source)

        methods = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef)
            and node.name in {"create", "_tick"}
        ]
        # Read the names actually combined into the window's ex-style, not
        # merely the ones defined somewhere in the file. A constant can be
        # defined and then left out of CreateWindowExW — which is exactly how
        # a click-through window quietly becomes a click-eating one.
        used = {
            n.id for method in methods for n in ast.walk(method)
            if isinstance(n, ast.Name)
        }
        for style in ("WS_EX_LAYERED", "WS_EX_TRANSPARENT",
                      "WS_EX_NOACTIVATE", "WS_EX_TOOLWINDOW"):
            self.assertIn(
                style, used,
                f"{style} must be passed to CreateWindowExW, not just defined",
            )
        self.assertIn("SW_SHOWNOACTIVATE", used)

    def test_overlay_draws_a_pointer_instead_of_a_text_banner(self):
        """The old 168x30 label was the black bar reported by Windows users."""
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertNotIn("DrawTextW", source)
        self.assertIn("ARROW_POINTS", source)
        self.assertIn("#0075f2", source.lower())
        self.assertIn("GaussianBlur", source)
        self.assertIn("UpdateLayeredWindow", source)

    def test_overlay_uses_the_agent_hotspot_not_a_cursor_offset(self):
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn("HOTSPOT", source)
        self.assertNotIn("CURSOR_OFFSET_X", source)
        self.assertNotIn("CURSOR_OFFSET_Y", source)

    def test_overlay_is_per_monitor_dpi_aware(self):
        """GetCursorPos and window placement must share physical coordinates."""
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn("DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2", source)
        self.assertIn("SetProcessDpiAwarenessContext", source)
        self.assertIn("GetDpiForMonitor", source)
        self.assertIn("GetDpiForWindow", source)

    @unittest.skipUnless(IS_WINDOWS, "requires Pillow and the Windows module")
    def test_overlay_renders_a_transparent_pointer_frame(self):
        spec = importlib.util.spec_from_file_location("win_cursor_badge", CURSOR_BADGE)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        frame = module._render_cursor(1.0, 0.0, None)
        self.assertEqual(frame.size, (module.CANVAS_SIZE, module.CANVAS_SIZE))
        self.assertEqual(frame.getpixel((0, 0))[3], 0)
        hotspot_x, hotspot_y = (round(value) for value in module.HOTSPOT)
        hotspot_alpha = max(
            frame.getpixel((hotspot_x + dx, hotspot_y + dy))[3]
            for dx in range(-1, 2)
            for dy in range(-1, 2)
        )
        self.assertGreater(hotspot_alpha, 200)
        self.assertLess(
            sum(pixel[3] > 8 for pixel in frame.getdata()),
            module.CANVAS_SIZE * module.CANVAS_SIZE // 2,
        )

    @unittest.skipUnless(IS_WINDOWS, "requires Pillow and the Windows module")
    def test_overlay_converts_frames_to_premultiplied_bgra(self):
        spec = importlib.util.spec_from_file_location("win_cursor_badge", CURSOR_BADGE)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        image = module.Image.new("RGBA", (1, 1), (100, 150, 200, 128))
        self.assertEqual(
            module._premultiplied_bgra(image),
            bytes((100, 75, 50, 128)),
        )

    def test_overlay_tracks_agent_input_and_not_the_users_pointer(self):
        """A virtual cursor stays at the agent's last point when the user moves."""
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn("WH_MOUSE_LL", source)
        self.assertIn("LLMHF_INJECTED", source)
        self.assertIn("_agent_position", source)
        self.assertNotIn("def _follow_cursor", source)

    def test_overlay_and_helper_share_a_session_input_tag(self):
        overlay = CURSOR_BADGE.read_text(encoding="utf-8")
        helper = _win_source()
        env_name = "CC_HAHA_COMPUTER_USE_INPUT_TAG"
        self.assertIn(env_name, overlay)
        self.assertIn(env_name, helper)
        self.assertIn("dwExtraInfo", overlay)

    def test_overlay_visibility_is_bound_to_the_controlled_window(self):
        """Never strand the AI pointer over an unrelated covering app."""
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn("targetPid", source)
        self.assertIn("WindowFromPoint", source)
        self.assertIn("GetForegroundWindow", source)

    def test_overlay_activity_does_not_hide_before_animated_motion(self):
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        start = source.index("    def _on_activity")
        end = source.index("    def _read_parent", start)
        body = source[start:end]
        self.assertNotIn("ShowWindow", body)
        self.assertIn("GetCursorPos", body)
        self.assertIn("self._requested_visible = self._target_pid is not None", body)

    def test_overlay_readiness_precedes_the_first_action(self):
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn('print("READY", flush=True)', source)

    def test_badge_exits_with_its_parent(self):
        """An orphaned badge is worse than none.

        It would sit on screen claiming the agent is controlling the mouse
        after the agent is gone. Tying it to stdin covers the parent being
        killed, not just exiting cleanly.
        """
        source = CURSOR_BADGE.read_text(encoding="utf-8")
        self.assertIn("stdin", source)

    @unittest.skipUnless(IS_WINDOWS, "requires the Windows window manager")
    def test_badge_declares_pointer_safe_win32_signatures(self):
        spec = importlib.util.spec_from_file_location("win_cursor_badge", CURSOR_BADGE)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertIs(module.user32.CreateWindowExW.restype, module.wintypes.HWND)
        self.assertIs(module.user32.CreateWindowExW.argtypes[3], module.wintypes.DWORD)
        self.assertIs(module.user32.DefWindowProcW.restype, module.LRESULT)
        for function in (
            module.user32.UpdateLayeredWindow,
            module.user32.SetWindowPos,
        ):
            self.assertIsNotNone(function.argtypes)
            self.assertIsNotNone(function.restype)

    @unittest.skipUnless(IS_WINDOWS, "requires the Windows window manager")
    def test_badge_message_loop_is_64_bit_safe(self):
        """Creating and closing the real window must not overflow ctypes.

        Default ctypes signatures treat Win32 handles and message parameters
        as 32-bit integers. That can appear to work until a 64-bit WPARAM,
        LPARAM, or HWND reaches the callback and is silently truncated.
        """
        process = subprocess.Popen(
            [sys.executable, str(CURSOR_BADGE), "--label", "Test"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        try:
            time.sleep(0.5)
            if process.poll() is not None:
                assert process.stderr is not None
                self.fail(f"badge exited during startup: {process.stderr.read()}")
            assert process.stdout is not None
            self.assertEqual(process.stdout.readline().strip(), "READY")
            assert process.stdin is not None
            process.stdin.close()
            returncode = process.wait(timeout=5)
            assert process.stderr is not None
            stderr = process.stderr.read()
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()

        self.assertEqual(returncode, 0, stderr)
        self.assertNotIn("Exception ignored on calling ctypes callback", stderr)
        self.assertNotIn("OverflowError", stderr)


class TestPermissions(unittest.TestCase):
    def test_check_permissions_always_granted(self):
        """Windows has no TCC equivalent for input injection or capture."""
        source = _win_source()
        start = source.index("def check_permissions()")
        body = source[start:start + 400]
        self.assertIn('"accessibility": True', body)
        self.assertIn('"screenRecording": True', body)


class TestDesktopHostIdentity(unittest.TestCase):
    def test_packaged_exe_maps_to_the_host_identity_sent_by_desktop(self):
        source = _win_source()
        self.assertIn(
            'DESKTOP_HOST_BUNDLE_ID = "com.claude-code-haha.desktop"',
            source,
        )
        self.assertIn('stem.casefold() == "claude code haha"', source)
        self.assertIn('"bundleId": _windows_bundle_id(exe_path)', source)


class TestSourceIntegrity(unittest.TestCase):
    def test_helper_parses(self):
        ast.parse(_win_source())

    def test_badge_parses(self):
        ast.parse(CURSOR_BADGE.read_text(encoding="utf-8"))

    def test_retired_mac_helper_is_not_referenced(self):
        """macOS is native-only; a lingering reference invites a false fallback."""
        self.assertFalse((RUNTIME_DIR / "mac_helper.py").exists())
        self.assertNotIn("mac_helper", _win_source())


if __name__ == "__main__":
    unittest.main(verbosity=2)
