import importlib.util
import json
import os
import shlex
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


class CliReceiptTests(unittest.TestCase):
    def test_ci_diagnostics_enforce_child_exit_status(self):
        workflow = (REPO / ".github/workflows/ci.yml").read_text()
        names = ("Status reports accessibility granted on a live bus",
                 "Status and permissions report the missing bus as denied accessibility")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "target/release/agent-desktop"
            binary.parent.mkdir(parents=True)
            binary.write_text(f"#!{sys.executable}\n" + textwrap.dedent('''
                import json, os, sys
                if sys.argv[1] == "click":
                    doc = {"ok": False, "error": {"code": "PERM_DENIED", "suggestion": "session bus"}}
                    code = 1
                else:
                    access = {"state": "denied" if os.environ.get("DBUS_SESSION_BUS_ADDRESS") == "unix:path=/nonexistent" else "granted", "suggestion": "session bus"}
                    doc = {"ok": True, "data": {"permissions": {"accessibility": access}}}
                    code = 0
                print(json.dumps(doc))
                sys.exit(int(os.environ["BAD_EXIT"]) if os.environ.get("BAD_COMMAND") == sys.argv[1] else code)
            '''))
            binary.chmod(0o700)
            for name, body in (("dbus-run-session", 'shift; exec "$@"'),
                               ("xvfb-run", 'shift; exec "$@"'),
                               ("python3", f'exec {shlex.quote(sys.executable)} "$@"'),
                               ("mktemp", f'exec /usr/bin/mktemp -d "{root}/runtime.XXXXXX"')):
                script = root / name
                script.write_text("#!/bin/sh\n" + body + "\n")
                script.chmod(0o700)
            for name in names:
                block = workflow.split("      - name: " + name + "\n", 1)[1]
                block = block.split("        run: |\n", 1)[1]
                block = textwrap.dedent(block.split("\n      - ", 1)[0].split("\n  test-", 1)[0])
                controls = [("", "17", True), ("status", "17", False)]
                if name == names[1]:
                    controls += [("permissions", "17", False), ("click", "17", False), ("click", "0", False)]
                for command, status, accepted in controls:
                    with self.subTest(step=name, command=command, status=status):
                        env = dict(PATH=str(root) + os.pathsep + os.defpath,
                                   RUNNER_TEMP=str(root), BAD_COMMAND=command, BAD_EXIT=status)
                        result = subprocess.run(["/bin/bash", "-e", "-c", block], cwd=root,
                                                env=env, capture_output=True, text=True, timeout=10)
                        self.assertEqual(result.returncode == 0, accepted, result.stdout + result.stderr)

    def test_capture_receipts_enforce_success_and_refusal_status(self):
        spec = importlib.util.spec_from_file_location("capture_cli", REPO / "scripts/check-linux-capture-cli.py")
        capture = importlib.util.module_from_spec(spec)
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "ad"
            spec.loader.exec_module(capture)
            capture.AD = str(binary)
            for ok, status in ((True, 0), (False, 1), (True, 17), (False, 17), (False, 0), (True, 1)):
                with self.subTest(ok=ok, status=status):
                    binary.write_text(f"#!{sys.executable}\nimport sys\nprint({json.dumps({'ok': ok})!r})\nsys.exit({status})\n")
                    binary.chmod(0o700)
                    if status == (0 if ok else 1):
                        self.assertEqual(capture.ad("permissions")["ok"], ok)
                    else:
                        with self.assertRaises(AssertionError):
                            capture.ad("permissions")
