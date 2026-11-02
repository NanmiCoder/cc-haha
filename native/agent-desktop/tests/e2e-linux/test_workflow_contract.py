import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent


class WorkflowTests(unittest.TestCase):
    def test_live_workflow_fails_closed(self):
        workflow = (REPO / ".github" / "workflows" / "linux-e2e.yml").read_text()
        self.assertIn("workflow_dispatch", workflow)
        self.assertIn("LINUX_E2E_RUNNER", workflow)
        self.assertNotIn("continue-on-error", workflow)
        self.assertIn("tests/e2e-linux/run.sh", workflow)

    def test_hosted_lane_runs_the_self_tests(self):
        ci = (REPO / ".github" / "workflows" / "ci.yml").read_text()
        discover = [line for line in ci.splitlines() if "discover -s tests/e2e-linux" in line]
        self.assertEqual(len(discover), 1, discover)
        self.assertIn("AGENT_DESKTOP_E2E_SKIP_LIVE=1", discover[0])



class SourceRuleTests(unittest.TestCase):
    def test_harness_cleanup_does_not_depend_on_a_trash_command(self):
        names = ("private-session.sh", "private-wayland-shell.sh",
                 "test-private-session.sh", "check-elf-glibc-floor-selftest.sh",
                 "ci-ffi-helper-discovery-smoke.sh")
        trash = re.compile(r"\btrash\b")
        paths = [REPO / "scripts" / name for name in names]
        paths += sorted((ROOT / "runner").glob("*.py")) + sorted((ROOT / "scenarios").glob("*.py"))
        paths += sorted((REPO / "tests" / "linux-dist").glob("run-*.sh"))
        paths = [path for path in paths if path.exists()]
        self.assertEqual([str(path) for path in paths if trash.search(path.read_text())], [])

    def test_runner_files_stay_under_the_line_cap(self):
        over = [
            path.name
            for path in (ROOT / "runner").glob("*.py")
            if len(path.read_text().splitlines()) >= 400
        ]
        self.assertEqual(over, [])
