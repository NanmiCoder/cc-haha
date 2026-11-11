import os
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import session


class RunnerRegressionTests(unittest.TestCase):
    def test_hup_replaces_ignore_and_unwinds_the_tier_synchronously(self):
        from contextlib import contextmanager
        from runner import main, gate, stage

        handlers = {signal.SIGHUP: signal.SIG_IGN}
        cleanup = []
        @contextmanager
        def tier():
            try:
                yield
            finally:
                cleanup.append("tier unwound")
        def run(*args):
            with tier():
                handlers[signal.SIGHUP](signal.SIGHUP, None)
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(os.environ, AGENT_DESKTOP_E2E_SUITE=directory), \
             patch.object(main, "_acquire_lease", return_value=None), \
             patch.object(gate, "check_prerequisites", return_value=[]), \
             patch.object(stage, "stage_binary", return_value=Path(directory) / "binary"), \
             patch.object(session, "sweep_strays"), \
             patch.object(main, "_run_tier", side_effect=run), \
             patch.object(main.signal, "signal", side_effect=lambda sig, handler: handlers.update({sig: handler})):
            with self.assertRaises(SystemExit) as raised:
                main.main(["--tier", "x11-openbox", "--leg", "lifecycle.window_operation_delivery_reports"])
        self.assertEqual(raised.exception.code, 129)
        self.assertEqual(cleanup, ["tier unwound"])

    def test_pre_handshake_timeout_sweeps_only_the_new_owned_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, suite = root / "base", root / "suite"
            base.mkdir()
            old = base / "rt.existing"
            old.mkdir()
            owner = f"{os.getpid()} {session._own_start_time()}"
            (old / session.OWNER_MARKER).write_text(owner)
            runtime = base / "rt.starting"
            wrapper = Mock(pid=555, stderr=None)
            wrapper.poll.return_value = None
            wrapper.wait.side_effect = [subprocess.TimeoutExpired("wrapper", 20),
                                        subprocess.TimeoutExpired("wrapper", 4), 0]
            members = []
            order = []
            def unhealthy(*args):
                runtime.mkdir()
                (runtime / session.OWNER_MARKER).write_text(owner)
                members.append((777, 123))
                raise session.TierUnavailable("health gate timeout before readiness")
            def sweep(path, proc_root):
                self.assertEqual(path, runtime)
                order.append("sweep")
                members.clear()
                return []
            def send(pid, sig):
                if sig == signal.SIGKILL:
                    self.assertFalse(members, "wrapper was killed before sweeping its members")
                    order.append("kill")
            with patch.dict(os.environ, AGENT_DESKTOP_SESSION_BASE=str(base), AGENT_DESKTOP_E2E_SUITE=str(suite)), \
                 patch.object(session.subprocess, "Popen", return_value=wrapper), \
                 patch.object(session, "_wait_for_health", side_effect=unhealthy), \
                 patch.object(session, "_signal_process", side_effect=send), \
                 patch.object(session, "_sweep_members", side_effect=sweep), \
                 patch.object(session, "_remove_tree", return_value=True) as remove:
                with self.assertRaisesRegex(session.TierUnavailable, "before readiness"):
                    with session.start_tier("x11-openbox", 1):
                        self.fail("unhealthy tier yielded")
            self.assertIn("sweep", order)
            self.assertLess(order.index("sweep"), order.index("kill"))
            remove.assert_called_once_with(runtime)
            self.assertTrue(old.exists())
            self.assertTrue((suite / "x11-openbox.release").exists())
