#!/usr/bin/env python3
import ctypes
import json
import os
import sys
import time
from ctypes import POINTER, Structure, byref, c_bool, c_char_p, c_double, c_int32
from ctypes import c_int64, c_uint32, c_uint64, c_uint8, c_void_p


class Scroll(Structure):
    _fields_ = [("direction", c_int32), ("amount", c_uint32)]


class Key(Structure):
    _fields_ = [("key", c_char_p), ("modifiers", POINTER(c_int32)), ("count", c_uint32)]


class Point(Structure):
    _fields_ = [("x", c_double), ("y", c_double)]


class Drag(Structure):
    _fields_ = [("from_point", Point), ("to_point", Point),
                ("duration_ms", c_uint64), ("drop_delay_ms", c_uint64)]


class Action(Structure):
    _fields_ = [("kind", c_int32), ("text", c_char_p), ("scroll", Scroll),
                ("key", Key), ("drag", Drag)]


EXECUTE_ARGS = [c_void_p, c_char_p, POINTER(Action), c_int32, POINTER(c_char_p)]
EXECUTE_TIMEOUT_ARGS = [c_void_p, c_char_p, POINTER(Action), c_int32, c_int64,
                        POINTER(c_char_p)]


def bind(lib, name, result, args):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = args
    return function


def take_json(pointer, free_string):
    if not pointer.value:
        return None
    raw = pointer.value
    free_string(pointer)
    return json.loads(raw)


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def ref_for(envelope, native_id):
    for node in walk(envelope["data"]["tree"]):
        identifier = node.get("native_id")
        identifier_value = identifier.get("value") if isinstance(identifier, dict) else identifier
        if identifier_value == native_id:
            ref_id = node.get("ref") or node.get("ref_id")
            if ref_id:
                return ref_id
    raise RuntimeError(f"snapshot omitted ref for {native_id}")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"default", "zero"}:
        raise RuntimeError("usage: ffi_live.py default|zero")
    mode = sys.argv[1]
    dylib = os.environ.get("AGENT_DESKTOP_E2E_FFI_DYLIB", "")
    if not dylib or not os.path.isfile(dylib):
        raise RuntimeError("immutable release FFI dylib is unavailable")
    lib = ctypes.CDLL(dylib)
    create = bind(lib, "ad_adapter_create_with_session", c_void_p, [c_char_p])
    destroy = bind(lib, "ad_adapter_destroy", None, [c_void_p])
    free_string = bind(lib, "ad_free_string", None, [c_char_p])
    action_size = bind(lib, "ad_action_size", ctypes.c_size_t, [])
    snapshot = bind(lib, "ad_snapshot", c_int32,
                    [c_void_p, c_char_p, c_int32, c_uint8, c_bool, c_bool, POINTER(c_char_p)])
    execute = bind(lib, "ad_execute_by_ref", c_int32, EXECUTE_ARGS)
    execute_timeout = bind(lib, "ad_execute_by_ref_timeout", c_int32, EXECUTE_TIMEOUT_ARGS)
    if action_size() != ctypes.sizeof(Action):
        raise RuntimeError("AdAction ctypes layout does not match the loaded release dylib")

    adapter = create(f"ffi-live-{os.getpid()}".encode())
    if not adapter:
        raise RuntimeError("release dylib refused to create a native adapter")
    click = Action()
    click.kind = 0

    def snap():
        out = c_char_p()
        rc = snapshot(adapter, b"AgentDeskFixture", 0, 10, False, False, byref(out))
        envelope = take_json(out, free_string)
        if rc == -8 or (envelope and envelope.get("error", {}).get("code") == "PLATFORM_NOT_SUPPORTED"):
            raise RuntimeError("stub FFI dylib rejected: native macOS adapter is required")
        if rc != 0 or not envelope or not envelope.get("ok"):
            raise RuntimeError(f"native FFI snapshot failed: rc={rc} envelope={envelope}")
        return envelope

    def act(ref_id, timeout=None):
        out = c_char_p()
        started = time.monotonic()
        if timeout is None:
            rc = execute(adapter, ref_id.encode(), byref(click), 0, byref(out))
        else:
            rc = execute_timeout(adapter, ref_id.encode(), byref(click), 0,
                                 timeout, byref(out))
        elapsed = round((time.monotonic() - started) * 1000)
        return rc, take_json(out, free_string), elapsed

    try:
        observed = snap()
        if act(ref_for(observed, "reset-delayed-button"))[0] != 0:
            raise RuntimeError("FFI fixture reset failed")
        observed = snap()
        if act(ref_for(observed, "enable-later"))[0] != 0:
            raise RuntimeError("FFI delayed-enable trigger failed")
        delayed = ref_for(observed, "delayed-button")
        if mode == "default":
            default_rc, default_env, default_ms = act(delayed)
            if default_rc != 0 or not default_env or not default_env.get("ok"):
                raise RuntimeError(f"default FFI auto-wait failed: {default_env}")
            if not 500 <= default_ms <= 2800:
                raise RuntimeError(f"default FFI auto-wait timing out of range: {default_ms}ms")
            print(json.dumps({"ok": True, "mode": mode, "elapsed_ms": default_ms}))
            return

        zero_rc, zero_env, zero_ms = act(delayed, 0)
        if zero_rc == 0 or not zero_env or zero_env.get("ok") is not False:
            raise RuntimeError(f"timeout-zero FFI action unexpectedly dispatched: {zero_env}")
        details = zero_env.get("error", {}).get("details", {})
        if details.get("actionable") is not False or not details.get("checks"):
            raise RuntimeError(f"timeout-zero FFI failure was not an actionability rejection: {zero_env}")
        if zero_ms > 900:
            raise RuntimeError(f"timeout-zero FFI action was not single-shot: {zero_ms}ms")
        time.sleep(1.2)
        print(json.dumps({"ok": True, "mode": mode, "elapsed_ms": zero_ms,
                          "zero_code": zero_env.get("error", {}).get("code")}))
    finally:
        destroy(adapter)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
