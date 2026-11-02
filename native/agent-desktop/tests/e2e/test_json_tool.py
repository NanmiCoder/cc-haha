#!/usr/bin/env python3
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

from json_tool import command_delivered_mechanism, command_get, run_bounded


class RunBoundedTests(unittest.TestCase):
    def test_delivered_mechanism_reports_the_first_successful_step(self):
        payload = {
            "ok": True,
            "data": {
                "steps": [
                    {"outcome": "skipped", "mechanism": "physical_synthetic"},
                    {"outcome": "succeeded", "mechanism": "semantic_api"},
                ]
            },
        }
        with mock.patch("json_tool.read_json", return_value=payload), mock.patch(
            "builtins.print"
        ) as output:
            command_delivered_mechanism()

        output.assert_called_once_with("semantic_api")

    def test_marked_child_receives_the_canonical_interaction_lease_fd(self):
        with tempfile.TemporaryFile() as lease:
            os.set_inheritable(lease.fileno(), True)
            environment = os.environ.copy()
            environment["AGENT_DESKTOP_INTERACTION_LEASE_FD"] = str(lease.fileno())
            result = run_bounded(
                [
                    sys.executable,
                    "-c",
                    "import os; os.fstat(int(os.environ['AGENT_DESKTOP_INTERACTION_LEASE_FD'])); print('inherited')",
                ],
                timeout_seconds=2,
                max_capture_bytes=1024,
                env=environment,
                inherit_interaction_lease=True,
            )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "inherited\n")

    def test_generic_shell_child_does_not_receive_the_interaction_lease(self):
        with tempfile.TemporaryFile() as lease:
            os.set_inheritable(lease.fileno(), True)
            environment = os.environ.copy()
            environment["AGENT_DESKTOP_INTERACTION_LEASE_FD"] = str(lease.fileno())
            result = run_bounded(
                [
                    "/bin/sh",
                    "-c",
                    'test -z "${AGENT_DESKTOP_INTERACTION_LEASE_FD+x}" && '
                    'test ! -e "/dev/fd/$1" && printf "not inherited\\n"',
                    "lease-check",
                    str(lease.fileno()),
                ],
                timeout_seconds=2,
                max_capture_bytes=1024,
                env=environment,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "not inherited\n")

    def test_captures_a_successful_child(self):
        result = run_bounded(
            [sys.executable, "-c", "print('ok')"],
            timeout_seconds=2,
            max_capture_bytes=1024,
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "ok\n")
        self.assertFalse(result.timed_out)
        self.assertFalse(result.output_limited)
        self.assertIsNone(result.termination_error)

    def test_descendant_holding_output_pipe_cannot_extend_the_deadline(self):
        descendant_pid = None
        try:
            result = run_bounded(
                [
                    sys.executable,
                    "-c",
                    "import subprocess,sys,time; "
                    "child = subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); "
                    "print(f'ready child={child.pid}', flush=True); time.sleep(30)",
                ],
                timeout_seconds=0.2,
                max_capture_bytes=1024,
            )

            self.assertEqual(result.returncode, 124)
            self.assertTrue(result.timed_out)
            self.assertIn("ready", result.stdout)
            self.assertLess(result.wall_ms, 2000)
            descendant_pid = int(result.stdout.split("child=", 1)[1].splitlines()[0])
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    os.kill(descendant_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail(f"output-pipe descendant {descendant_pid} survived the deadline kill")
        finally:
            if descendant_pid is not None:
                try:
                    os.kill(descendant_pid, 9)
                except ProcessLookupError:
                    pass

    def test_timeout_kills_term_ignoring_descendant_after_leader_exits(self):
        child_pid = None
        child = (
            "import os,signal,time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print(f'child={os.getpid()}', flush=True); time.sleep(30)"
        )
        leader = (
            "import signal,subprocess,sys,time; "
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); "
            "subprocess.Popen([sys.executable, '-c', sys.argv[1]]); "
            "time.sleep(30)"
        )
        try:
            result = run_bounded(
                [sys.executable, "-c", leader, child],
                timeout_seconds=0.3,
                max_capture_bytes=1024,
            )
            child_pid = int(result.stdout.split("child=", 1)[1].splitlines()[0])
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail(f"TERM-ignoring descendant {child_pid} survived timeout cleanup")
        finally:
            if child_pid is not None:
                try:
                    os.kill(child_pid, 9)
                except ProcessLookupError:
                    pass

    def test_group_signal_failure_is_reported_without_blocking(self):
        with mock.patch("json_tool.os.killpg", side_effect=PermissionError("denied")):
            result = run_bounded(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                timeout_seconds=0.05,
                max_capture_bytes=1024,
            )

        self.assertTrue(result.timed_out)
        self.assertIn("SIGTERM failed", result.termination_error)
        self.assertLess(result.wall_ms, 2000)

    def test_stops_unbounded_output(self):
        result = run_bounded(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 100000)"],
            timeout_seconds=2,
            max_capture_bytes=4096,
        )

        self.assertEqual(result.returncode, 125)
        self.assertTrue(result.output_limited)
        self.assertLessEqual(len(result.stdout.encode()), 4096)


class CommandGetTests(unittest.TestCase):
    def render_path(self, payload, path):
        with mock.patch("json_tool.read_json", return_value=payload), mock.patch(
            "builtins.print"
        ) as output:
            command_get(path)
        return output.call_args.args[0]

    def test_missing_list_index_renders_empty_so_a_stopped_batch_has_no_later_entry(self):
        payload = {"data": {"results": [{"ok": True}, {"ok": False}]}}

        self.assertEqual(self.render_path(payload, "data.results.1.ok"), "False")
        self.assertEqual(self.render_path(payload, "data.results.2.ok"), "")

    def test_missing_object_key_renders_empty(self):
        self.assertEqual(self.render_path({"ok": True}, "data.stopped"), "")


if __name__ == "__main__":
    unittest.main()
