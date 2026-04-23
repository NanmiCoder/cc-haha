#!/usr/bin/env python3
"""Cross-platform tests for mac_helper.py and win_helper.py.

Tests the platform-independent parts (JSON protocol, key mapping, capture logic)
without requiring platform-specific dependencies. Can run on any OS with pytest.

Usage:
    python -m pytest runtime/test_helpers.py -v
    # or simply:
    python runtime/test_helpers.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Determine which helper to test based on current platform
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

RUNTIME_DIR = Path(__file__).parent
MAC_HELPER = RUNTIME_DIR / "mac_helper.py"
WIN_HELPER = RUNTIME_DIR / "win_helper.py"


class TestKeyMap(unittest.TestCase):
    """Test the KEY_MAP and normalize_key function — platform-independent logic."""

    def _load_key_map(self, helper_path: Path) -> dict[str, str]:
        """Extract KEY_MAP from a helper by importing it with mocked deps."""
        # Read the file and extract just the KEY_MAP dict
        source = helper_path.read_text()
        # Find KEY_MAP definition
        start = source.index("KEY_MAP = {")
        # Find the matching closing brace
        depth = 0
        for i, ch in enumerate(source[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        key_map_source = source[start:end]
        ns: dict = {}
        exec(key_map_source, ns)
        return ns["KEY_MAP"]

    def test_mac_key_map_exists(self):
        if not MAC_HELPER.exists():
            self.skipTest("mac_helper.py not found")
        km = self._load_key_map(MAC_HELPER)
        self.assertIn("cmd", km)
        self.assertIn("ctrl", km)
        self.assertEqual(km["cmd"], "command")
        self.assertEqual(km["alt"], "option")

    def test_win_key_map_exists(self):
        if not WIN_HELPER.exists():
            self.skipTest("win_helper.py not found")
        km = self._load_key_map(WIN_HELPER)
        self.assertIn("cmd", km)
        self.assertIn("ctrl", km)
        # Windows maps cmd/command/meta to 'win' key
        self.assertEqual(km["cmd"], "win")
        self.assertEqual(km["command"], "win")
        self.assertEqual(km["meta"], "win")
        # Windows maps alt/option to 'alt'
        self.assertEqual(km["alt"], "alt")
        self.assertEqual(km["option"], "alt")

    def test_common_keys_present_in_both(self):
        """Both helpers must have the same set of key names."""
        if not MAC_HELPER.exists() or not WIN_HELPER.exists():
            self.skipTest("Both helpers required")
        mac_km = self._load_key_map(MAC_HELPER)
        win_km = self._load_key_map(WIN_HELPER)
        # All keys in mac should be in win and vice versa
        self.assertEqual(set(mac_km.keys()), set(win_km.keys()),
                         "KEY_MAP keys must be identical across platforms")

    def test_all_alphabet_keys(self):
        """All a-z keys should map to themselves."""
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            km = self._load_key_map(helper)
            for char in "abcdefghijklmnopqrstuvwxyz":
                self.assertEqual(km[char], char, f"{helper.name}: {char} should map to itself")

    def test_all_digit_keys(self):
        """All 0-9 keys should map to themselves."""
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            km = self._load_key_map(helper)
            for digit in "0123456789":
                self.assertEqual(km[digit], digit, f"{helper.name}: {digit} should map to itself")

    def test_function_keys(self):
        """F1-F12 should map to themselves."""
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            km = self._load_key_map(helper)
            for i in range(1, 13):
                key = f"f{i}"
                self.assertEqual(km[key], key, f"{helper.name}: {key} should map to itself")


class TestJSONProtocol(unittest.TestCase):
    """Test that both helpers follow the same JSON command protocol."""

    def _get_helper(self) -> Path:
        """Get the appropriate helper for the current platform."""
        if IS_WINDOWS and WIN_HELPER.exists():
            return WIN_HELPER
        if IS_MACOS and MAC_HELPER.exists():
            return MAC_HELPER
        return MAC_HELPER if MAC_HELPER.exists() else WIN_HELPER

    def _parse_main_commands(self, helper_path: Path) -> list[str]:
        """Extract all command names from the main() dispatcher."""
        source = helper_path.read_text()
        commands = []
        for line in source.splitlines():
            stripped = line.strip()
            if stripped.startswith('if command == "'):
                cmd = stripped.split('"')[1]
                commands.append(cmd)
        return commands

    def test_both_helpers_same_commands(self):
        """Both helpers must support the exact same set of commands."""
        if not MAC_HELPER.exists() or not WIN_HELPER.exists():
            self.skipTest("Both helpers required")
        mac_cmds = set(self._parse_main_commands(MAC_HELPER))
        win_cmds = set(self._parse_main_commands(WIN_HELPER))
        self.assertEqual(mac_cmds, win_cmds,
                         f"Command sets differ.\nOnly in mac: {mac_cmds - win_cmds}\nOnly in win: {win_cmds - mac_cmds}")

    def test_expected_commands_exist(self):
        """Core commands should be present in each helper."""
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
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            cmds = set(self._parse_main_commands(helper))
            missing = expected - cmds
            self.assertFalse(missing,
                             f"{helper.name} missing commands: {missing}")

    def test_unknown_command_returns_error(self):
        """Running a non-existent command should return a JSON error."""
        helper = self._get_helper()
        if not helper.exists():
            self.skipTest("No helper found")
        # On macOS without venv, mac_helper.py may fail at import (AppKit);
        # on Windows without venv, win_helper.py may fail at import (win32gui).
        # Only test if the helper can actually import.
        check = subprocess.run(
            [sys.executable, "-c", f"import importlib.util; "
             f"spec = importlib.util.spec_from_file_location('h', '{helper}')"],
            capture_output=True, text=True
        )
        result = subprocess.run(
            [sys.executable, str(helper), "nonexistent_command_xyz"],
            capture_output=True, text=True
        )
        if result.returncode == 1 and not result.stdout.strip():
            # Import failed — platform deps missing, skip this test
            self.skipTest(f"Cannot run {helper.name} on this platform (missing deps)")
        # Should exit with code 2
        self.assertEqual(result.returncode, 2)
        parsed = json.loads(result.stdout.strip())
        self.assertFalse(parsed["ok"])
        self.assertEqual(parsed["error"]["code"], "bad_command")


class TestHelperOutputFormat(unittest.TestCase):
    """Test the JSON output helpers are consistent."""

    def test_json_output_function_exists(self):
        """Both helpers should define json_output and error_output."""
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            source = helper.read_text()
            self.assertIn("def json_output(", source,
                          f"{helper.name} missing json_output function")
            self.assertIn("def error_output(", source,
                          f"{helper.name} missing error_output function")

    def test_main_entry_point(self):
        """Both helpers should have the standard main entry point."""
        for helper in [MAC_HELPER, WIN_HELPER]:
            if not helper.exists():
                continue
            source = helper.read_text()
            self.assertIn('if __name__ == "__main__":', source,
                          f"{helper.name} missing __main__ guard")
            self.assertIn("def main()", source,
                          f"{helper.name} missing main() function")


class TestWinHelperPermissions(unittest.TestCase):
    """Windows-specific: permissions should always return True."""

    def test_check_permissions_always_granted(self):
        """On Windows, permissions are not needed — should always be True."""
        if not WIN_HELPER.exists():
            self.skipTest("win_helper.py not found")

        # Extract and exec just the check_permissions function
        source = WIN_HELPER.read_text()

        # Find the function
        self.assertIn("def check_permissions()", source)

        # The function should return both as True
        # We can verify by reading the source
        start = source.index("def check_permissions()")
        # Find next def or end
        rest = source[start:]
        lines = rest.split("\n")
        func_lines = [lines[0]]
        for line in lines[1:]:
            if line and not line[0].isspace() and not line.startswith("#"):
                break
            func_lines.append(line)
        func_source = "\n".join(func_lines)
        self.assertIn('"accessibility": True', func_source)
        self.assertIn('"screenRecording": True', func_source)


class TestMacHelperPermissions(unittest.TestCase):
    """macOS helper permission detection should use the official trust API."""

    def test_check_permissions_uses_ax_api_instead_of_system_events(self):
        if not MAC_HELPER.exists():
            self.skipTest("mac_helper.py not found")

        source = MAC_HELPER.read_text()

        self.assertIn("def detect_accessibility_permission()", source)
        self.assertIn("AXIsProcessTrusted", source)

        start = source.index("def check_permissions()")
        rest = source[start:]
        lines = rest.split("\n")
        func_lines = [lines[0]]
        for line in lines[1:]:
            if line and not line[0].isspace() and not line.startswith("#"):
                break
            func_lines.append(line)
        func_source = "\n".join(func_lines)

        self.assertIn("detect_accessibility_permission()", func_source)
        self.assertNotIn('tell application "System Events"', func_source)

    def test_clipboard_shortcuts_use_osascript_path(self):
        if not MAC_HELPER.exists():
            self.skipTest("mac_helper.py not found")

        source = MAC_HELPER.read_text()
        self.assertIn("def paste_clipboard()", source)
        self.assertIn('send_keystroke_via_osascript("v", ["command"])', source)
        self.assertIn('if parts == ["command", "v"]:', source)
        self.assertIn('elif parts == ["command", "a"]:', source)


class TestCrossPlatformFunctions(unittest.TestCase):
    """Test functions that are identical between both helpers."""

    def _get_function_body(self, helper_path: Path, func_name: str) -> str:
        """Extract a function's body (code lines only, no comments/blanks)."""
        source = helper_path.read_text()
        marker = f"def {func_name}("
        if marker not in source:
            return ""
        start = source.index(marker)
        rest = source[start:]
        lines = rest.split("\n")
        func_lines = [lines[0]]
        for line in lines[1:]:
            # Stop at next top-level def/class or non-indented non-empty line
            stripped = line.strip()
            if line and not line[0].isspace() and stripped and not stripped.startswith("#"):
                break
            # Skip comments and blank lines for comparison
            if stripped.startswith("#") or not stripped:
                continue
            func_lines.append(line)
        return " ".join(" ".join(func_lines).split())

    def test_input_functions_identical(self):
        """Input action functions (click, scroll, etc.) should be identical."""
        if not MAC_HELPER.exists() or not WIN_HELPER.exists():
            self.skipTest("Both helpers required")
        for func in ["click", "scroll", "hold_keys", "type_text"]:
            mac_src = self._get_function_body(MAC_HELPER, func)
            win_src = self._get_function_body(WIN_HELPER, func)
            self.assertEqual(mac_src, win_src,
                             f"{func} should be identical across platforms")


if __name__ == "__main__":
    unittest.main()
