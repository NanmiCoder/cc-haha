from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from runner import main, product, stage
from runner.session import Tier


def fake_tier(root: Path, name: str = "x11-openbox") -> Tier:
    runtime = Path(root) / "rt.test"
    runtime.mkdir(exist_ok=True)
    return Tier(
        name=name,
        runtime_dir=runtime,
        display=":100",
        wayland_display=None,
        bus_address="unix:path=/nonexistent/bus",
        a11y_bus_address="unix:path=/nonexistent/atspi",
        state_root=runtime,
        keyfile=runtime / "keyfile",
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path.home())},
    )


def make_binary(root: Path, body: str) -> Path:
    path = Path(root) / "fake-agent-desktop"
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o700)
    helper = root / "agent-desktop-linux-clipboard-owner"
    helper.write_text("#!/bin/sh\necho clipboard-owner\n")
    helper.chmod(0o700)
    return path


class StageTests(unittest.TestCase):
    def test_staged_program_can_invoke_adjacent_clipboard_owner(self):
        with tempfile.TemporaryDirectory() as root:
            source = make_binary(Path(root), 'exec "$(dirname "$0")/agent-desktop-linux-clipboard-owner"')
            suite = Path(root) / "suite"
            target = stage.stage_binary(source, suite)
            result = subprocess.run([str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "clipboard-owner")
            helper = target.with_name("agent-desktop-linux-clipboard-owner")
            helper.chmod(0o700)
            helper.write_text("#!/bin/sh\necho changed\n")
            self.assertFalse(stage.verify_staged(target, suite))

    def test_reused_suite_rejects_a_changed_source_image(self):
        for image in ("cli", "helper"):
            with self.subTest(image=image), tempfile.TemporaryDirectory() as root:
                source = make_binary(Path(root), "echo version")
                suite = Path(root) / "suite"
                stage.stage_binary(source, suite)
                changed = source if image == "cli" else source.with_name(stage.HELPER_NAME)
                changed.write_text("#!/bin/sh\necho another-build\n")
                with self.assertRaises(stage.StagedBinaryModified):
                    stage.stage_binary(source, suite)

    def test_stage_records_hash_and_reverifies(self):
        with tempfile.TemporaryDirectory() as root:
            source = make_binary(Path(root), "echo version")
            suite = Path(root) / "suite"
            target = stage.stage_binary(source, suite)
            self.assertTrue(target.is_file())
            self.assertFalse(os.access(target, os.W_OK))
            self.assertTrue((suite / "bin" / "agent-desktop.sha256").is_file())
            self.assertTrue(stage.verify_staged(target, suite))
            second = stage.stage_binary(source, suite)
            self.assertEqual(second, target)

    def test_altered_staged_binary_fails_verification(self):
        with tempfile.TemporaryDirectory() as root:
            source = make_binary(Path(root), "echo version")
            suite = Path(root) / "suite"
            target = stage.stage_binary(source, suite)
            target.chmod(0o700)
            target.write_text("#!/bin/sh\necho tampered\n")
            self.assertFalse(stage.verify_staged(target, suite))
            with self.assertRaises(stage.StagedBinaryModified):
                stage.stage_binary(source, suite)

    def test_missing_source_is_a_gate_error(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                stage.stage_binary(Path(root) / "absent", Path(root) / "suite")


class EnvelopeTests(unittest.TestCase):
    def test_cli_child_inherits_the_held_interaction_lease(self):
        body = '''exec python3 -c 'import json, os; os.fstat(int(os.environ["AGENT_DESKTOP_INTERACTION_LEASE_FD"])); print(json.dumps({"ok": True, "data": {"inherited": True}}))' '''
        with tempfile.TemporaryFile() as lease, mock.patch.dict(
                os.environ, {"AGENT_DESKTOP_INTERACTION_LEASE_FD": str(lease.fileno())}):
            envelope = self.run_argv(body)
        self.assertTrue(envelope.ok, envelope.raw)
        self.assertEqual(envelope.data, {"inherited": True})

    def run_argv(self, body, **kw):
        with tempfile.TemporaryDirectory() as root:
            binary = make_binary(Path(root), body)
            tier = fake_tier(Path(root))
            with mock.patch.dict(os.environ, {"AGENT_DESKTOP_E2E_BIN": str(binary)}):
                return product.run_product(tier, ["snapshot"], **kw)

    def test_valid_envelope_parses(self):
        envelope = self.run_argv('printf \'{"ok":true,"data":{"n":1}}\'')
        self.assertTrue(envelope.ok)
        self.assertEqual(envelope.data, {"n": 1})
        self.assertIsNone(envelope.error)
        self.assertEqual(envelope.exit_code, 0)
        self.assertEqual(envelope.argv[-1], "snapshot")

    def test_error_envelope_passes_through(self):
        envelope = self.run_argv(
            'printf \'{"ok":false,"error":{"code":"STALE_REF","message":"gone"}}\'; exit 1'
        )
        self.assertFalse(envelope.ok)
        self.assertEqual(envelope.error["code"], "STALE_REF")
        self.assertEqual(envelope.exit_code, 1)

    def test_exit_status_must_match_the_envelope(self):
        for body, status in (
            ('{"ok":true,"data":{}}', 17),
            ('{"ok":false,"error":{"code":"STALE_REF"}}', 0),
            ('{"ok":false,"error":{"code":"STALE_REF"}}', 2),
        ):
            with self.subTest(status=status, body=body):
                envelope = self.run_argv(f"printf '%s' '{body}'; exit {status}")
                self.assertFalse(envelope.ok)
                self.assertEqual(envelope.error["code"], "HARNESS_EXIT_MISMATCH")
                self.assertIn(f"exit {status}", envelope.error["message"])
                self.assertIn(body, envelope.raw)

    def test_malformed_stdout_is_a_harness_error_with_raw(self):
        envelope = self.run_argv("printf 'this is not json'")
        self.assertFalse(envelope.ok)
        self.assertEqual(envelope.error["code"], "HARNESS_MALFORMED_ENVELOPE")
        self.assertIn("this is not json", envelope.raw)

    def test_timeout_is_bounded(self):
        envelope = self.run_argv("sleep 30", timeout_s=0.5)
        self.assertFalse(envelope.ok)
        self.assertEqual(envelope.error["code"], "HARNESS_TIMEOUT")
        self.assertLess(envelope.elapsed_ms, 15000)

    def test_flooding_output_is_bounded(self):
        envelope = self.run_argv("yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        self.assertFalse(envelope.ok)
        self.assertEqual(envelope.error["code"], "HARNESS_OUTPUT_LIMIT")

    def test_headed_and_window_id_shape_the_argv(self):
        envelope = self.run_argv(
            "printf '{}'", headed=True, window_id="0x123"
        )
        self.assertEqual(envelope.error["code"], "HARNESS_MALFORMED_ENVELOPE")
        self.assertEqual(envelope.argv[1], "--headed")
        self.assertEqual(envelope.argv[-2:], ["--window-id", "0x123"])

    def test_lying_wrapper_envelope_still_parses(self):
        with tempfile.TemporaryDirectory() as root:
            binary = main._write_lying_binary(Path(root))
            tier = fake_tier(Path(root))
            with mock.patch.dict(os.environ, {"AGENT_DESKTOP_E2E_BIN": str(binary)}):
                envelope = product.run_product(tier, ["click", "@e1"])
        self.assertTrue(envelope.ok)
        self.assertEqual(envelope.data, {"headless": True})
