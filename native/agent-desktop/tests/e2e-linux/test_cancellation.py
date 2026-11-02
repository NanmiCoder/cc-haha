import json
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import cancel


class CancellationTests(unittest.TestCase):
    def test_ready_receipt_signals_only_the_named_runner_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            suite = Path(directory)
            runtime = suite / "rt.owned"
            runtime.mkdir()
            marker = runtime / "harness-owner"
            marker.write_text("4242 77\n")
            tier = SimpleNamespace(runtime_dir=runtime, name="x11-mutter")
            with patch.object(cancel.os, "getpid", return_value=4242), \
                 patch.object(cancel.session, "_own_start_time", return_value=77):
                path = cancel.publish(suite, tier)
            receipt = json.loads(path.read_text())
            self.assertEqual(receipt["runtime"], str(runtime))
            self.assertEqual(receipt["marker"], str(marker))
            self.assertEqual((receipt["pid"], receipt["start"]), (4242, 77))
            process = suite / "proc/4242"
            process.mkdir(parents=True)
            command = process / "cmdline"
            command.write_bytes(b"python3\0-I\0" + receipt["runner"].encode() + b"\0")
            for mismatch in (None, "generation", "command", "marker"):
                with self.subTest(mismatch=mismatch), \
                     patch.object(cancel.os, "pidfd_open", return_value=99, create=True) as opened, \
                     patch.object(cancel.signal, "pidfd_send_signal", create=True) as send, \
                     patch.object(cancel.os, "close") as close:
                    candidate = dict(receipt)
                    current_start = "78" if mismatch == "generation" else "77"
                    (process / "stat").write_text("4242 (python3) S " + "0 " * 18 + current_start + "\n")
                    command.write_bytes(b"unrelated\0" if mismatch == "command"
                                        else b"python3\0" + receipt["runner"].encode() + b"\0")
                    marker.write_text("4243 77\n" if mismatch == "marker" else "4242 77\n")
                    if mismatch:
                        with self.assertRaisesRegex(RuntimeError, "refusing SIGTERM"):
                            cancel.terminate(candidate, suite / "proc")
                        send.assert_not_called()
                    else:
                        cancel.terminate(candidate, suite / "proc")
                        send.assert_called_once_with(99, signal.SIGTERM)
                    opened.assert_called_once_with(4242)
                    close.assert_called_once_with(99)

    def test_cleanup_wait_requires_both_runtime_and_members_to_be_gone(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "ready.json"
            runtime = Path(directory) / "rt.owned"
            receipt.write_text(json.dumps({"runtime": str(runtime)}))
            for exists, members in ((True, []), (False, [(4242, 77)]), (False, [])):
                with self.subTest(exists=exists, members=members), \
                     patch.object(cancel.session, "_proc_members", return_value=members), \
                     patch.object(cancel.Path, "exists", return_value=exists):
                    if exists or members:
                        with self.assertRaises(TimeoutError):
                            cancel.main([str(receipt), "--check-cleanup", "--wait", "0"])
                    else:
                        cancel.main([str(receipt), "--check-cleanup", "--wait", "0"])
