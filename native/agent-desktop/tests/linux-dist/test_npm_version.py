import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class InstalledVersionTests(unittest.TestCase):
    def test_valid_stdout_cannot_hide_a_failed_version_process(self):
        for failed in ("symlink", "native", "none"):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                scripts = root / "tests/linux-dist"
                scripts.mkdir(parents=True)
                shutil.copy(Path(__file__).with_name("run-npm-install.sh"), scripts)
                (scripts / "curl-double.sh").touch()
                (root / "npm").mkdir()
                archive = root / "archives"
                archive.mkdir()
                (archive / "agent-desktop-v1-x86_64-unknown-linux-gnu.tar.gz").touch()
                doubles = root / "bin"
                doubles.mkdir()

                def executable(name, body):
                    path = doubles / name
                    path.write_text(body)
                    path.chmod(0o700)

                version = json.dumps({"ok": True, "data": {"os": "linux", "target": "x86_64"}})
                executable("uname", "#!/bin/sh\necho x86_64\n")
                executable("node", f'''#!{sys.executable}
import sys
if sys.argv[1] == "-p": print("1")
''')
                binary_script = (f"#!{sys.executable}\nimport os, sys\nprint({version!r})\n"
                                 'failed = os.environ["FAIL_VERSION"]\n'
                                 'native = sys.argv[0].endswith("agent-desktop-linux-x64")\n'
                                 'sys.exit(17 if (failed == "native") == native and failed != "none" else 0)\n')
                executable("npm", f'''#!{sys.executable}
import os, pathlib, sys
if sys.argv[1] == "pack":
    work = pathlib.Path(sys.argv[sys.argv.index("--pack-destination") + 1])
    (work / "package.tgz").touch()
    print("package.tgz")
else:
    prefix = pathlib.Path(sys.argv[sys.argv.index("--prefix") + 1])
    installed = prefix / "lib/node_modules/agent-desktop/bin"
    installed.mkdir(parents=True, exist_ok=True)
    native = installed / "agent-desktop-linux-x64"
    native.write_text({binary_script!r})
    native.chmod(0o700)
    os.link(native, installed / "agent-desktop")
    (prefix / "bin").mkdir(parents=True, exist_ok=True)
    os.symlink(installed / "agent-desktop", prefix / "bin/agent-desktop")
    pathlib.Path(os.environ["AD_CURL_DOUBLE_LOG"]).write_text("/agent-desktop-v1-x86_64-unknown-linux-gnu.tar.gz\\n/checksums.txt\\n")
''')
                executable("python3", f'''#!{sys.executable}
import os, sys
if sys.argv[1].endswith("linux_helper.py"): sys.exit(73)
os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])
''')
                env = dict(os.environ, PATH=f"{doubles}:{os.environ['PATH']}",
                           AGENT_DESKTOP_PRIVATE_SESSION=str(root), FAIL_VERSION=failed)
                result = subprocess.run(["bash", str(scripts / "run-npm-install.sh"), str(archive)],
                                        env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 73 if failed == "none" else 17,
                                 result.stdout + result.stderr)
