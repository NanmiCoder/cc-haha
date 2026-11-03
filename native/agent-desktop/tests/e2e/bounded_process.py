import dataclasses
import os
import resource
import selectors
import signal
import subprocess
import time


DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_MAX_CAPTURE_BYTES = 2 * 1024 * 1024
INTERACTION_LEASE_FD_ENV = "AGENT_DESKTOP_INTERACTION_LEASE_FD"
INHERIT_INTERACTION_LEASE_ENV = "AGENT_DESKTOP_E2E_INHERIT_LEASE"


@dataclasses.dataclass
class BoundedResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool
    output_limited: bool
    termination_error: str | None
    wall_ms: float
    cpu_ms: float


def _terminate_group(process):
    process_group = process.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        return None
    except OSError as error:
        try:
            process.terminate()
        except OSError:
            pass
        return f"process-group SIGTERM failed: {error}"
    grace_deadline = time.monotonic() + 0.25
    while time.monotonic() < grace_deadline:
        try:
            os.killpg(process_group, 0)
        except ProcessLookupError:
            process.poll()
            return None
        except OSError:
            break
        time.sleep(0.01)
    try:
        os.killpg(process_group, signal.SIGKILL)
    except ProcessLookupError:
        return None
    except OSError as error:
        try:
            process.kill()
        except OSError:
            pass
        return f"process-group SIGKILL failed: {error}"
    return None


def _merge_error(current, additional):
    if not additional:
        return current
    return f"{current}; {additional}" if current else additional


def _interaction_lease_fds(env):
    environment = os.environ if env is None else env
    raw_fd = environment.get(INTERACTION_LEASE_FD_ENV)
    if raw_fd is None:
        return ()
    try:
        fd = int(raw_fd)
    except ValueError as error:
        raise ValueError("interaction lease FD must be a decimal integer") from error
    if fd < 0:
        raise ValueError("interaction lease FD must be nonnegative")
    os.fstat(fd)
    return (fd,)


def _close_streams(selector, process):
    for stream in (process.stdout, process.stderr):
        if stream is None:
            continue
        try:
            selector.unregister(stream)
        except (KeyError, ValueError):
            pass
        stream.close()


def run_bounded(
    command,
    timeout_seconds=None,
    max_capture_bytes=None,
    env=None,
    inherit_interaction_lease=False,
):
    timeout_seconds = float(
        timeout_seconds
        if timeout_seconds is not None
        else os.environ.get("AGENT_DESKTOP_E2E_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    )
    max_capture_bytes = int(
        max_capture_bytes
        if max_capture_bytes is not None
        else os.environ.get("AGENT_DESKTOP_E2E_MAX_CAPTURE_BYTES", DEFAULT_MAX_CAPTURE_BYTES)
    )
    if timeout_seconds <= 0 or max_capture_bytes <= 0:
        raise ValueError("timeout and capture limits must be positive")

    usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.perf_counter()
    child_env = dict(os.environ if env is None else env)
    pass_fds = _interaction_lease_fds(child_env) if inherit_interaction_lease else ()
    if not inherit_interaction_lease:
        child_env.pop(INTERACTION_LEASE_FD_ENV, None)
    child_env.pop(INHERIT_INTERACTION_LEASE_ENV, None)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        env=child_env,
        pass_fds=pass_fds,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks = {"stdout": [], "stderr": []}
    captured = 0
    deadline = started + timeout_seconds
    timed_out = False
    output_limited = False
    termination_error = None

    while selector.get_map():
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            timed_out = True
            termination_error = _merge_error(termination_error, _terminate_group(process))
            _close_streams(selector, process)
            break
        events = selector.select(min(remaining, 0.1))
        if not events:
            process.poll()
            continue
        for key, _ in events:
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                selector.unregister(key.fileobj)
                key.fileobj.close()
                continue
            available = max_capture_bytes - captured
            if len(data) > available:
                if available > 0:
                    chunks[key.data].append(data[:available])
                    captured += available
                output_limited = True
                termination_error = _merge_error(termination_error, _terminate_group(process))
                _close_streams(selector, process)
                break
            chunks[key.data].append(data)
            captured += len(data)
        if output_limited:
            break

    selector.close()
    if not timed_out and not output_limited:
        remaining = max(0.0, deadline - time.perf_counter())
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            timed_out = True
            termination_error = _merge_error(termination_error, _terminate_group(process))
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        termination_error = _merge_error(termination_error, _terminate_group(process))
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            termination_error = _merge_error(
                termination_error, "child could not be reaped after termination"
            )

    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_before = usage_before.ru_utime + usage_before.ru_stime
    cpu_after = usage_after.ru_utime + usage_after.ru_stime
    if timed_out:
        returncode = 124
    elif output_limited:
        returncode = 125
    elif process.returncode is None:
        returncode = 126
    else:
        returncode = int(process.returncode)
    return BoundedResult(
        args=list(command),
        returncode=returncode,
        stdout=b"".join(chunks["stdout"]).decode("utf-8", errors="replace"),
        stderr=b"".join(chunks["stderr"]).decode("utf-8", errors="replace"),
        timed_out=timed_out,
        output_limited=output_limited,
        termination_error=termination_error,
        wall_ms=(time.perf_counter() - started) * 1000,
        cpu_ms=max(0.0, (cpu_after - cpu_before) * 1000),
    )
