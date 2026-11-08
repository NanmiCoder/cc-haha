"""Stop only this private runtime's accessibility bus, using stable handles."""
import os
from pathlib import Path
import signal
import sys
import time


def facts(directory):
    try:
        stat = (directory / "stat").read_text()
        start = int(stat[stat.rfind(")") + 2:].split()[19])
        environment = (directory / "environ").read_bytes().split(b"\0")
        comm = (directory / "comm").read_text().strip()
        command = (directory / "cmdline").read_bytes()
        return start, environment, comm, command
    except (OSError, ValueError, IndexError):
        return None


def owned_bus(value, runtime):
    if value is None or b"XDG_RUNTIME_DIR=" + os.fsencode(runtime) not in value[1]:
        return False
    executable = value[3].split(b"\0", 1)[0].rsplit(b"/", 1)[-1]
    return executable in (b"at-spi-bus-launcher", b"at-spi2-registryd") or (
        value[2] == "dbus-daemon" and b"at-spi" in value[3])


def stop(runtime, proc=Path("/proc"), opener=None, sender=None, closer=os.close,
         read=facts):
    opener = opener or os.pidfd_open
    sender = sender or signal.pidfd_send_signal
    stopped = []
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        before = read(directory)
        if not owned_bus(before, runtime):
            continue
        descriptor = None
        try:
            descriptor = opener(int(directory.name), 0)
            after = read(directory)
            if after is not None and after[0] == before[0] and owned_bus(after, runtime):
                sender(descriptor, signal.SIGTERM, None, 0)
                stopped.append((directory, before[0]))
        except ProcessLookupError:
            pass
        finally:
            if descriptor is not None:
                closer(descriptor)
    return stopped


if __name__ == "__main__":
    stopped = stop(sys.argv[1])
    if not stopped:
        raise SystemExit("no owned private accessibility bus process")
    deadline = time.monotonic() + 5
    while any(owned_bus(value := facts(path), sys.argv[1]) and value[0] == start
              for path, start in stopped):
        if time.monotonic() >= deadline:
            raise SystemExit("private accessibility bus did not exit")
        time.sleep(0.05)
