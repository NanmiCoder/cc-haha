import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class WaylandWrapperTests(unittest.TestCase):
    def test_successful_shell_start_keeps_the_owned_pid_for_cleanup(self):
        source = (Path(__file__).resolve().parents[2] / "scripts/private-wayland-shell.sh").read_text()
        replacements = {
            "healthy": "return 0", "close_overview": "return 0", "start_portals": "return 0",
        }
        for name, body in replacements.items():
            source, count = re.subn(r"(?ms)^" + name + r"\(\) \{\n.*?^\}",
                                    name + "() {\n  " + body + "\n}", source)
            self.assertEqual(count, 1)
        source = re.sub(r"(?m)^sockets\(\) \{.*\}$",
                        'sockets() { [ ! -f "$XDG_RUNTIME_DIR/test-socket" ] || printf "wayland-test\\n"; }', source)
        spies = ('\nfind() { :; }\nsetsid() { : > "$XDG_RUNTIME_DIR/test-socket"; }\n'
                 'payload() { printf "%s:%s" "$shell_pid" "$WAYLAND_DISPLAY" > "$TEST_PAYLOAD"; }\n'
                 'kill() { printf "%s\\n" "$*" >> "$TEST_KILL_LOG"; }\n'
                 'wait() { :; }\nsleep() { :; }\n')
        source = source.replace("set -euo pipefail\n", "set -euo pipefail\n" + spies, 1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "wrapper.sh"
            script.write_text(source)
            env = dict(os.environ, AGENT_DESKTOP_PRIVATE_SESSION=directory,
                       XDG_RUNTIME_DIR=directory, TEST_KILL_LOG=str(root / "signals"),
                       TEST_PAYLOAD=str(root / "payload"))
            result = subprocess.run(["bash", str(script), "--", "payload"], env=env,
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            signals = (root / "signals").read_text() if (root / "signals").exists() else ""
            pid, socket = (root / "payload").read_text().split(":")
            self.assertEqual(socket, "wayland-test")
            self.assertIn(pid, signals, "the shell PID was lost before EXIT cleanup")
