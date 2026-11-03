import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


class ConsumerEntryTests(unittest.TestCase):
    def test_packaged_ctypes_failure_fails_the_consumer(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "tests/linux-dist"
            scripts.mkdir(parents=True)
            for name in ("run-consumer.sh", "observations.sh"):
                shutil.copy(Path(__file__).with_name(name), scripts / name)
            archive = root / "archive"
            for name in ("lib/libagent_desktop_ffi.so", "include/agent_desktop.h"):
                path = archive / name
                path.parent.mkdir(exist_ok=True, parents=True)
                path.touch()
            doubles = root / "bin"
            doubles.mkdir()

            def executable(name, body):
                path = doubles / name
                path.write_text(body)
                path.chmod(0o755)
                return path

            executable("cc", '''#!/usr/bin/env bash
while [ "$1" != "-o" ]; do shift; done
cp "$FAKE_CONSUMER" "$2"
''')
            consumer = executable("consumer", '''#!/usr/bin/env bash
case "$1" in
  snapshot) printf '%s\n' '{"ok":true,"data":{"complete":true,"ref_count":1,"nodes":[{"role":"button","name":"7","ref_id":"@s1:e1"}]}}' ;;
  click) exit 74 ;;
esac
''')
            app = executable("app", "#!/usr/bin/env bash\nexec sleep 60\n")
            executable("python3", f'''#!{sys.executable}
import json, os, sys
if sys.argv[1].endswith("atspi_read.py"):
    print("0")
elif sys.argv[1].endswith("smoke.py"):
    print(json.dumps({{key: os.environ.get(key) for key in
        ("AD_EXPECT_REAL", "AD_APP", "AD_DYLIB_PATH", "AD_HEADER_PATH")}}), flush=True)
    sys.exit(73)
else:
    os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])
''')
            env = dict(os.environ, PATH=f"{doubles}:{os.environ['PATH']}",
                       FAKE_CONSUMER=str(consumer), AD_APP=str(app),
                       AGENT_DESKTOP_PRIVATE_SESSION=str(root))
            result = subprocess.run(["bash", str(scripts / "run-consumer.sh"), str(archive)],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 73, result.stdout + result.stderr)
            observed = json.loads(next(line for line in result.stdout.splitlines()
                                       if line.startswith('{"AD_EXPECT_REAL"')))
            self.assertEqual(observed, {
                "AD_EXPECT_REAL": "1", "AD_APP": str(app),
                "AD_DYLIB_PATH": str(archive / "lib/libagent_desktop_ffi.so"),
                "AD_HEADER_PATH": str(archive / "include/agent_desktop.h"),
            })
