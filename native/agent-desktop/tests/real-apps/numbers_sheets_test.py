"""Run with python3 tests/real-apps/numbers_sheets_test.py, or
python3 -m unittest discover -s tests/real-apps -p '*_test.py'."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("numbers-sheets.sh")

FAKE_BINARY = """#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == click && "$FAIL_CLICK" == 1 ]]; then
    echo '{"ok":false,"error":{"disposition":{"retry":"unsafe"}}}'
    exit 1
fi
echo '{"ok":true}'
"""


class NumbersSheetsTest(unittest.TestCase):
    def run_script(self, fail_click, cycles):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        fake = root / "fake-ad"
        fake.write_text(FAKE_BINARY)
        fake.chmod(0o700)
        calls = root / "calls"
        result = subprocess.run(
            ["bash", str(SCRIPT), str(fake), "w-123", "@stest:e1", "@stest:e2", str(cycles)],
            env={
                **os.environ,
                "CALLS": str(calls),
                "FAIL_CLICK": "1" if fail_click else "0",
                "AGENT_DESKTOP_HOME": str(root),
            },
            capture_output=True, text=True, check=False,
        )
        evidence = re.search(r"^Evidence: (\S+)$", result.stderr, re.MULTILINE)
        if evidence:
            self.addCleanup(shutil.rmtree, evidence.group(1), ignore_errors=True)
        commands = calls.read_text().splitlines() if calls.exists() else []
        return result, commands

    def test_failed_click_stops_after_one_diagnostic_screenshot(self):
        result, commands = self.run_script(fail_click=True, cycles=2)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(commands[:2], ["list-windows --app Numbers", "click @stest:e1"])
        self.assertEqual(len(commands), 3, commands)
        self.assertTrue(commands[2].startswith("screenshot --window-id w-123 "), commands)
        self.assertIn('"retry":"unsafe"', result.stdout)

    def test_successful_clicks_run_the_full_transition_sequence(self):
        result, commands = self.run_script(fail_click=False, cycles=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(commands), 17, commands)
        self.assertEqual(commands[1], "click @stest:e1")
        self.assertEqual(commands[9], "click @stest:e2")


if __name__ == "__main__":
    unittest.main()
