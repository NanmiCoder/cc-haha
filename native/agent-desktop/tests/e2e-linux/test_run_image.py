import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from runner import prepare, stage


class RunImageTests(unittest.TestCase):
    def test_build_pins_both_images_before_another_build_can_replace_the_shared_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            suite, shared = root / "suite", root / "shared"
            shared.mkdir()
            (shared / "agent-desktop").write_text("previous build")
            def build(argv, *, env, **kwargs):
                release = Path(env["CARGO_TARGET_DIR"]) / "release"
                release.mkdir(parents=True)
                for name in ("agent-desktop", stage.HELPER_NAME):
                    image = release / name
                    image.write_text(f"#!/bin/sh\necho built-{name}\n")
                    image.chmod(0o700)
            def launch(*args):
                self.assertEqual((shared / "agent-desktop").read_text(), "previous build")
                for image in shared.rglob("agent-desktop*"):
                    image.write_text("another worktree build")
                for name in ("agent-desktop", stage.HELPER_NAME):
                    image = suite / "bin" / name
                    expected = f"#!/bin/sh\necho built-{name}\n".encode()
                    self.assertEqual(image.read_bytes(), expected)
                    self.assertEqual(image.with_name(name + ".sha256").read_text().split()[0],
                                     hashlib.sha256(expected).hexdigest())
                self.assertEqual(os.environ["AGENT_DESKTOP_E2E_BIN_SRC"], str(suite / "bin/agent-desktop"))
            env = {"AGENT_DESKTOP_E2E_SUITE": str(suite), "CARGO_TARGET_DIR": str(shared)}
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(prepare.subprocess, "run", side_effect=build), \
                 patch.object(prepare.os, "execv", side_effect=launch):
                prepare.main(["--tier", "x11-mutter"])
            self.assertFalse((suite / "build").exists())
