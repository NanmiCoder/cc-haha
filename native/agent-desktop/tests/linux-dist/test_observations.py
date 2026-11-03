import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest


SCRIPT = Path(__file__).with_name("observations.sh")


class ClickObservationTests(unittest.TestCase):
    def run_click(self, baseline="0", observed="7", baseline_status=0, refs=1):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot.json"
            snapshot.write_text(json.dumps([
                {"role": "button", "name": "7", "ref_id": f"@s1:e{i}"}
                for i in range(refs)
            ]))
            result = subprocess.run([
                "bash", "-c", '''
source "$1"
snapshot=$2 baseline=$3 observed=$4 baseline_status=$5 clicked=$6 output=$7
read_display() {
  if [ -f "$clicked" ]; then
    printf '%s' "$observed"
  else
    printf '%s' "$baseline"
    return "$baseline_status"
  fi
}
click() { printf '%s' "$*" > "$clicked"; }
sleep() { :; }
click_display_transition "$snapshot" "$output" click
''',
                "observation-test", str(SCRIPT), str(snapshot), baseline,
                observed, str(baseline_status), str(root / "clicked"), str(root / "out"),
            ], capture_output=True, text=True, timeout=10)
            return result, (root / "clicked").exists()

    def test_click_requires_a_changed_display(self):
        result, clicked = self.run_click()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(clicked)
        self.assertIn("display=7 before=0", result.stdout)

    def test_already_expected_display_is_not_delivery(self):
        result, clicked = self.run_click(baseline="7")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BASELINE_UNCHANGED", result.stderr)
        self.assertFalse(clicked)

    def test_baseline_read_failure_is_not_delivery(self):
        result, clicked = self.run_click(baseline_status=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BASELINE_READ", result.stderr)
        self.assertFalse(clicked)

    def test_successful_noop_is_not_delivery(self):
        result, clicked = self.run_click(observed="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ACTION_NOT_DELIVERED", result.stderr)
        self.assertTrue(clicked)

    def test_ambiguous_button_is_never_clicked(self):
        result, clicked = self.run_click(refs=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected one button", result.stderr)
        self.assertFalse(clicked)


class ClipboardObservationTests(unittest.TestCase):
    def run_clear(self, statuses):
        with TemporaryDirectory() as directory:
            reads = Path(directory) / "reads"
            result = subprocess.run([
                "bash", "-c", '''
source "$1"
reads=$2
shift 2
statuses=("$@")
read_clipboard() {
  printf 'read\n' >> "$reads"
  return "${statuses[0]}"
}
sleep() { statuses=("${statuses[@]:1}"); }
observe_clipboard_clear
''', "observation-test", str(SCRIPT), str(reads), *map(str, statuses),
            ], capture_output=True, text=True, timeout=10)
            return result, len(reads.read_text().splitlines())

    def test_only_no_text_status_confirms_clear(self):
        result, reads = self.run_clear([3])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(reads, 1)

    def test_observer_error_never_confirms_clear(self):
        result, reads = self.run_clear([1])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OBSERVER_ERROR status=1", result.stderr)
        self.assertEqual(reads, 1)

    def test_remaining_text_is_polled_until_no_text(self):
        result, reads = self.run_clear([0, 0, 3])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(reads, 3)

    def test_persistent_text_fails_clear(self):
        result, reads = self.run_clear([0] * 100)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CLIPBOARD_CLEAR", result.stderr)
        self.assertEqual(reads, 100)
