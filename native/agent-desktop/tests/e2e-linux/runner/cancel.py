from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from runner import session


def publish(suite: Path, tier) -> Path:
    marker = tier.runtime_dir / session.OWNER_MARKER
    pid, start = map(int, marker.read_text().split())
    if (pid, start) != (os.getpid(), session._own_start_time()):
        raise RuntimeError("the runtime marker does not name this runner generation")
    receipt = {"pid": pid, "start": start, "runtime": str(tier.runtime_dir),
               "marker": str(marker), "runner": str(Path(__file__).with_name("main.py").resolve())}
    path = suite / f"{tier.name}.ready.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt) + "\n")
    temporary.replace(path)
    print(f"cancel-ready: {path} {json.dumps(receipt)}", flush=True)
    return path


def terminate(receipt: dict, proc_root: Path = Path("/proc")) -> None:
    pid, start = int(receipt["pid"]), int(receipt["start"])
    if pid <= 1 or start <= 0:
        raise RuntimeError("invalid runner generation")
    fd = os.pidfd_open(pid)
    try:
        process = proc_root / str(pid)
        marker = Path(receipt["runtime"]) / session.OWNER_MARKER
        runner = str(Path(__file__).with_name("main.py").resolve())
        if (receipt["marker"] != str(marker) or receipt["runner"] != runner
                or marker.read_text().split() != [str(pid), str(start)]
                or session._process_start_time(process) != start
                or process.stat().st_uid != os.getuid()
                or runner.encode() not in (process / "cmdline").read_bytes().split(b"\0")):
            raise RuntimeError("refusing SIGTERM: runner, marker or generation changed")
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    finally:
        os.close(fd)


def wait_for(predicate, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError("the requested readiness/cleanup condition did not arrive")
        time.sleep(0.1)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Signal only the ready runner's verified generation")
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--wait", type=float, default=120)
    parser.add_argument("--check-cleanup", action="store_true")
    args = parser.parse_args(argv)
    wait_for(args.receipt.is_file, args.wait)
    receipt = json.loads(args.receipt.read_text())
    if args.check_cleanup:
        runtime = Path(receipt["runtime"])
        wait_for(lambda: not runtime.exists() and not session._proc_members(runtime), args.wait)
        print(f"cleanup verified: {runtime}")
    else:
        terminate(receipt)
        print(f"SIGTERM sent: pid={receipt['pid']} start={receipt['start']} runtime={receipt['runtime']}")


if __name__ == "__main__":
    main(sys.argv[1:])
