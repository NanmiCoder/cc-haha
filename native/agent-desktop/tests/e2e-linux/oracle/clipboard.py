from __future__ import annotations

import os
import signal
import subprocess
import time

from runner.session import Tier

DEFAULT_TIMEOUT_S = 5.0
MAX_CAPTURE_BYTES = 16 * 1024 * 1024

TEXT_FORMATS = ("text", "text/plain", "text/plain;charset=utf-8")
_OWNERS: dict[int, subprocess.Popen] = {}


class ClipboardError(RuntimeError):
    pass


def backend(tier: Tier) -> str:
    return "wayland" if tier.wayland_display else "x11"


def xclip_target(fmt: str) -> str:
    if fmt in TEXT_FORMATS:
        return "UTF8_STRING"
    return fmt


def set_command(backend_name: str, fmt: str) -> list[str]:
    if backend_name == "wayland":
        return ["wl-copy", "--foreground", "--type", fmt]
    return ["xclip", "-selection", "clipboard", "-quiet", "-t", xclip_target(fmt), "-i"]


def get_command(backend_name: str, fmt: str) -> list[str]:
    if backend_name == "wayland":
        return ["wl-paste", "--no-newline", "--type", fmt]
    return ["xclip", "-selection", "clipboard", "-o", "-t", xclip_target(fmt)]


def _environment(tier: Tier) -> dict[str, str]:
    return dict(tier.env)


def _run(argv: list[str], env: dict[str, str], timeout_s: float = DEFAULT_TIMEOUT_S):
    process = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _terminate(process.pid)
        stdout, stderr = process.communicate()
        return 124, stdout, stderr
    return process.returncode, stdout, stderr


def _terminate(pid: int) -> None:
    for number in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, number)
        except ProcessLookupError:
            return
        except PermissionError:
            return
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                return
            time.sleep(0.01)


def foreign_set(tier: Tier, fmt: str, data: bytes) -> int:
    argv = set_command(backend(tier), fmt)
    process = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=_environment(tier),
        start_new_session=True,
    )
    try:
        process.stdin.write(data)
        process.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read().decode("utf-8", errors="replace")
            process.stderr.close()
            raise ClipboardError(f"clipboard setter exited {process.returncode}: {stderr.strip()}")
        time.sleep(0.02)
    _OWNERS[process.pid] = process
    return process.pid


def stop_owner(pid: int) -> None:
    process = _OWNERS.pop(pid, None)
    if process is None:
        raise ValueError("refusing to stop an unattributed clipboard owner")
    try:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
    finally:
        if process.stderr:
            process.stderr.close()


def foreign_get(tier: Tier, fmt: str) -> bytes | None:
    code, stdout, _ = _run(get_command(backend(tier), fmt), _environment(tier))
    if code != 0 or len(stdout) > MAX_CAPTURE_BYTES:
        return None
    return stdout
