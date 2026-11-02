#!/usr/bin/env python3
"""Count threads and descriptors across repeated timed-out display reads in an FFI host.

The display address is a loopback TCP server that accepts every connection and
never answers, so each ad_list_displays call reaches its deadline. The counters
come from /proc, never from the library under test.

Usage:
    python3 tests/ffi-python/leak_probe.py <library.so> [--calls N]

Exit codes:
    0   every call timed out with flat host threads and descriptors
    1   setup failed or a resource/deadline assertion failed
    2   usage error
"""

import argparse
import ctypes
import os
import socket
import sys
import multiprocessing
import time

AD_RESULT_TIMEOUT = -9


class SilentServer:
    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.number = None
        for candidate in range(200, 1000):
            try:
                self.listener.bind(("127.0.0.1", 6000 + candidate))
                self.number = candidate
                break
            except OSError:
                continue
        if self.number is None:
            raise OSError("no free X11 TCP display port")
        self.listener.listen(64)
        self.port = 6000 + self.number
        self.held = []
        context = multiprocessing.get_context("fork")
        self.stopped = context.Event()
        self.worker = context.Process(target=self.serve, daemon=True)
        self.worker.start()
        self.listener.close()

    def serve(self):
        self.listener.settimeout(0.2)
        while not self.stopped.is_set():
            try:
                connection, _ = self.listener.accept()
            except OSError:
                continue
            self.held.append(connection)

    def close(self):
        self.stopped.set()
        self.worker.join(timeout=2)
        if self.worker.is_alive():
            self.worker.terminate()
            self.worker.join()
        self.worker.close()


def count(directory):
    try:
        return len(os.listdir(directory))
    except OSError:
        return -1


def bind(lib, name, restype, argtypes):
    function = getattr(lib, name, None)
    if function is None:
        raise AttributeError(name)
    function.restype = restype
    function.argtypes = argtypes
    return function


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("library")
    parser.add_argument("--calls", type=int, default=50)
    args = parser.parse_args()
    if args.calls < 1:
        parser.error("--calls must be at least 1")

    try:
        lib = ctypes.CDLL(args.library)
        create = bind(lib, "ad_adapter_create", ctypes.c_void_p, [])
        destroy = bind(lib, "ad_adapter_destroy", None, [ctypes.c_void_p])
        list_displays = bind(
            lib,
            "ad_list_displays",
            ctypes.c_int32,
            [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)],
        )
        free_list = bind(lib, "ad_display_list_free", None, [ctypes.c_void_p])
    except (OSError, AttributeError) as error:
        print(f"leak_probe: {error}", file=sys.stderr)
        return 1

    server = SilentServer()
    os.environ.pop("WAYLAND_DISPLAY", None)
    os.environ["DISPLAY"] = f"127.0.0.1:{server.number}"
    adapter = create()
    if not adapter:
        print("leak_probe: ad_adapter_create returned null", file=sys.stderr)
        server.close()
        return 1

    failures = 0
    try:
        warm = ctypes.c_void_p()
        assert list_displays(adapter, ctypes.byref(warm)) == AD_RESULT_TIMEOUT
        if warm:
            free_list(warm)
        baseline = (count("/proc/self/task"), count("/proc/self/fd"))
        print(f"baseline threads={baseline[0]} descriptors={baseline[1]}", flush=True)
        for index in range(1, args.calls + 1):
            out = ctypes.c_void_p()
            started = time.monotonic()
            result = list_displays(adapter, ctypes.byref(out))
            elapsed = time.monotonic() - started
            if out:
                free_list(out)
            threads = count("/proc/self/task")
            descriptors = count("/proc/self/fd")
            if result != AD_RESULT_TIMEOUT or (threads, descriptors) != baseline or not 4.9 <= elapsed <= 6.3:
                failures += 1
            print(
                f"call={index} result={result} threads={threads} descriptors={descriptors} elapsed={elapsed:.3f}",
                flush=True,
            )
    finally:
        destroy(adapter)
        server.close()

    print(f"calls={args.calls} failures={failures}")
    return int(failures != 0)


if __name__ == "__main__":
    sys.exit(main())
