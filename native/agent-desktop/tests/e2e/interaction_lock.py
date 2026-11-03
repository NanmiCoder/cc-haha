#!/usr/bin/env python3
import fcntl
import os
import stat
import subprocess
import sys


LEASE_FD_ENV = "AGENT_DESKTOP_INTERACTION_LEASE_FD"


def canonical_lock_path(root="/tmp"):
    directory = os.path.join(root, f"agent-desktop-{os.geteuid()}")
    return directory, os.path.join(directory, "interaction.lock")


def _prepare_directory(directory):
    try:
        os.mkdir(directory, 0o700)
    except FileExistsError:
        pass
    metadata = os.lstat(directory)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError("interaction lease parent is not a real directory")
    if metadata.st_uid != os.geteuid():
        raise RuntimeError("interaction lease parent is not owned by this user")
    os.chmod(directory, 0o700)


def acquire(root="/tmp"):
    directory, path = canonical_lock_path(root)
    _prepare_directory(directory)
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid():
        os.close(fd)
        raise RuntimeError("interaction lease is not a private user-owned regular file")
    if metadata.st_nlink != 1:
        os.close(fd)
        raise RuntimeError("interaction lease has an unexpected link count")
    os.fchmod(fd, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    os.set_inheritable(fd, True)
    return fd


def verify_inherited(raw_fd):
    fd = int(raw_fd)
    if fd < 0:
        raise ValueError("interaction lease FD must be nonnegative")
    metadata = os.fstat(fd)
    _, path = canonical_lock_path()
    canonical = os.stat(path, follow_symlinks=False)
    if (metadata.st_dev, metadata.st_ino) != (canonical.st_dev, canonical.st_ino):
        raise RuntimeError("interaction lease FD does not identify the canonical lock")
    return fd


def run(command):
    fd = acquire()
    if fd is None:
        print("SKIP (blocked): canonical desktop interaction lease is held", file=sys.stderr)
        return 2
    try:
        environment = os.environ.copy()
        environment[LEASE_FD_ENV] = str(fd)
        return subprocess.run(command, env=environment, pass_fds=(fd,), check=False).returncode
    finally:
        os.close(fd)


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "run":
        raise SystemExit(run(sys.argv[2:]))
    if len(sys.argv) == 3 and sys.argv[1] == "verify":
        verify_inherited(sys.argv[2])
        return
    raise SystemExit("usage: interaction_lock.py run COMMAND... | verify FD")


if __name__ == "__main__":
    main()
