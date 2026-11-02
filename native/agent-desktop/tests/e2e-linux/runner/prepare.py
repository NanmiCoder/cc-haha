from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS))
from runner import stage


def main(argv: list[str]) -> None:
    base = Path(
        os.environ.get("AGENT_DESKTOP_SESSION_BASE")
        or (Path(os.environ["XDG_RUNTIME_DIR"]) / "agent-desktop-sessions"
            if os.environ.get("XDG_RUNTIME_DIR") else Path(f"/tmp/agent-desktop-sessions-{os.getuid()}"))
    )
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    suite = Path(os.environ.get("AGENT_DESKTOP_E2E_SUITE")
                 or tempfile.mkdtemp(prefix="e2e-suite-", dir=base)).resolve()
    suite.mkdir(parents=True, exist_ok=True)
    os.environ["AGENT_DESKTOP_E2E_SUITE"] = str(suite)
    print(f"suite: {suite}", flush=True)
    if "--lying-actions" not in argv:
        source = os.environ.get("AGENT_DESKTOP_E2E_BIN_SRC") or os.environ.get("AGENT_DESKTOP_E2E_BIN")
        if source is None:
            build_dir = suite / "build"
            if build_dir.exists():
                raise RuntimeError("use a fresh suite: its build directory already exists")
            env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(build_dir))
            subprocess.run(["cargo", "build", "--locked", "--release", "-p", "agent-desktop",
                            "-p", "agent-desktop-linux", "--bins"],
                           cwd=HARNESS.parent.parent, env=env, check=True)
            source = build_dir / "release/agent-desktop"
        binary = stage.stage_binary(Path(source), suite)
        if source == suite / "build/release/agent-desktop":
            shutil.rmtree(suite / "build")
        os.environ["AGENT_DESKTOP_E2E_BIN_SRC"] = str(binary)
        for name in ("agent-desktop", stage.HELPER_NAME):
            print(f"image: {(suite / 'bin' / (name + '.sha256')).read_text().strip()}", flush=True)
    os.execv(sys.executable, [sys.executable, str(HARNESS.parent / "e2e/interaction_lock.py"),
                             "run", sys.executable, "-I", str(HARNESS / "runner/main.py"), *argv])


if __name__ == "__main__":
    main(sys.argv[1:])
