"""
FFI smoke harness: proves the C ABI works from a non-Rust host (Python ctypes).

Usage:
    python3 tests/ffi-python/smoke.py <dylib_path> <header_path>

Environment variables (override positional args):
    AD_DYLIB_PATH    path to libagent_desktop_ffi.{dylib,so,dll}
    AD_HEADER_PATH   path to crates/ffi/include/agent_desktop.h

Exit codes:
    0   all legs passed
    1   assertion failure or load error (message printed to stderr)
"""

import ctypes
import json
import os
import re
import sys
import threading
from ctypes import (
    POINTER,
    c_bool,
    c_char_p,
    c_int,
    c_size_t,
    c_uint,
    c_uint8,
    c_void_p,
    byref,
)
from pathlib import Path


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"  ok: {msg}")


def bind(lib: ctypes.CDLL, name: str, restype, argtypes: list) -> ctypes.CFUNCTYPE:
    """Bind one symbol; raises AttributeError with a clear name if missing."""
    try:
        fn = getattr(lib, name)
    except AttributeError:
        fail(f"symbol not found in dylib: {name}")
    fn.restype = restype
    fn.argtypes = argtypes
    return fn


def parse_header_constants(header_path: str) -> dict:
    """
    Parse numeric #define constants from the header.

    Returns a dict mapping macro name → int value.
    Only plain integer literals are handled (no expressions).
    """
    text = Path(header_path).read_text()
    result = {}
    for m in re.finditer(r"#define\s+(\w+)\s+(\d+)", text):
        result[m.group(1)] = int(m.group(2))
    return result


# ---------------------------------------------------------------------------
# resolve paths
# ---------------------------------------------------------------------------

def resolve_paths() -> tuple[str, str]:
    dylib = os.environ.get("AD_DYLIB_PATH") or (sys.argv[1] if len(sys.argv) > 1 else "")
    header = os.environ.get("AD_HEADER_PATH") or (sys.argv[2] if len(sys.argv) > 2 else "")
    if not dylib:
        fail("dylib path required: pass as argv[1] or set AD_DYLIB_PATH")
    if not header:
        fail("header path required: pass as argv[2] or set AD_HEADER_PATH")
    if not Path(dylib).exists():
        fail(f"dylib not found: {dylib}")
    if not Path(header).exists():
        fail(f"header not found: {header}")
    return dylib, header


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    dylib_path, header_path = resolve_paths()

    print(f"\nLoading dylib: {dylib_path}")
    try:
        lib = ctypes.CDLL(dylib_path)
    except OSError as exc:
        fail(f"failed to load dylib: {exc}")

    constants = parse_header_constants(header_path)

    # ------------------------------------------------------------------
    # Bind all symbols upfront with explicit restype + argtypes.
    # A missing or wrong-arity symbol surfaces an AttributeError here,
    # before any assertion runs.
    # ------------------------------------------------------------------

    ad_abi_version = bind(lib, "ad_abi_version", c_uint, [])

    # Size getters — restype c_size_t, no args
    ad_action_size        = bind(lib, "ad_action_size",        c_size_t, [])
    ad_action_result_size = bind(lib, "ad_action_result_size", c_size_t, [])
    ad_action_step_size   = bind(lib, "ad_action_step_size",   c_size_t, [])
    ad_drag_params_size   = bind(lib, "ad_drag_params_size",   c_size_t, [])
    ad_element_state_size = bind(lib, "ad_element_state_size", c_size_t, [])
    ad_ref_entry_size     = bind(lib, "ad_ref_entry_size",     c_size_t, [])
    ad_wait_args_size     = bind(lib, "ad_wait_args_size",     c_size_t, [])

    # String management
    ad_version     = bind(lib, "ad_version",     c_int, [POINTER(c_char_p)])
    ad_free_string = bind(lib, "ad_free_string", None,  [c_char_p])

    # Adapter lifecycle
    ad_adapter_create  = bind(lib, "ad_adapter_create",  c_void_p, [])
    ad_adapter_destroy = bind(lib, "ad_adapter_destroy", None,     [c_void_p])
    ad_get_clipboard = bind(lib, "ad_get_clipboard", c_int, [c_void_p, POINTER(c_char_p)])
    ad_last_error_message = bind(lib, "ad_last_error_message", c_char_p, [])

    # Snapshot (adapter leg)
    ad_snapshot = bind(
        lib, "ad_snapshot", c_int,
        [c_void_p, c_char_p, c_int, c_uint8, c_bool, c_bool, POINTER(c_char_p)],
    )

    print("\nLeg 1 — ABI version handshake")
    expected_major = constants.get("AD_ABI_VERSION_MAJOR")
    if expected_major is None:
        fail("AD_ABI_VERSION_MAJOR not found in header")

    got_major = ad_abi_version()
    if got_major != expected_major:
        fail(
            f"ad_abi_version() returned {got_major}, "
            f"expected {expected_major} (AD_ABI_VERSION_MAJOR from header)"
        )
    ok(f"ad_abi_version() == AD_ABI_VERSION_MAJOR == {expected_major}")

    # ------------------------------------------------------------------
    print("\nLeg 2 — struct size getters vs. header macros")
    # ------------------------------------------------------------------

    # Explicit table: (getter_fn, macro_name) — no name-mangling magic.
    size_pairs = [
        (ad_action_size,        "AD_ACTION_SIZE"),
        (ad_action_result_size, "AD_ACTION_RESULT_SIZE"),
        (ad_action_step_size,   "AD_ACTION_STEP_SIZE"),
        (ad_drag_params_size,   "AD_DRAG_PARAMS_SIZE"),
        (ad_element_state_size, "AD_ELEMENT_STATE_SIZE"),
        (ad_ref_entry_size,     "AD_REF_ENTRY_SIZE"),
        (ad_wait_args_size,     "AD_WAIT_ARGS_SIZE"),
    ]

    for getter, macro in size_pairs:
        expected = constants.get(macro)
        if expected is None:
            fail(f"{macro} not found in header")
        got = getter()
        if got != expected:
            fail(f"{macro}: dylib getter returned {got}, header says {expected} (struct layout drift)")
        ok(f"{macro}: {got} bytes")

    # ------------------------------------------------------------------
    print("\nLeg 3 — ad_version returns parseable JSON with data.version")
    # ------------------------------------------------------------------

    out = c_char_p()
    rc = ad_version(byref(out))
    if rc != 0:
        fail(f"ad_version() returned {rc}, expected 0 (AD_RESULT_OK)")
    if out.value is None:
        fail("ad_version() returned OK but *out is null")

    raw = out.value  # bytes — read before freeing
    ad_free_string(out)

    try:
        envelope = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"ad_version() output is not valid JSON: {exc}\nraw: {raw!r}")

    if not envelope.get("ok"):
        fail(f"ad_version() envelope has ok!=true: {envelope}")

    data = envelope.get("data")
    if not isinstance(data, dict) or "version" not in data:
        fail(f"ad_version() envelope missing data.version: {envelope}")

    ok(f"ad_version() -> data.version = {data['version']!r}")

    # ------------------------------------------------------------------
    print("\nLeg 4 — adapter leg: create → snapshot → assert PLATFORM_NOT_SUPPORTED → destroy")
    # ------------------------------------------------------------------

    expect_stub = os.environ.get("AD_EXPECT_STUB") == "1"

    adapter = ad_adapter_create()
    if not adapter:
        fail("ad_adapter_create() returned null")
    ok("ad_adapter_create() non-null")

    snap_out = c_char_p()
    rc = ad_snapshot(
        adapter,   # adapter pointer
        None,      # app (null = focused window)
        0,         # surface = Window
        10,        # max_depth
        False,     # interactive_only
        False,     # compact
        byref(snap_out),
    )

    # Under the stub adapter, a command-level error writes the error
    # envelope to *out rather than nulling it.  Parse regardless of rc.
    if snap_out.value is not None:
        raw_snap = snap_out.value
        ad_free_string(snap_out)

        try:
            snap_env = json.loads(raw_snap)
        except json.JSONDecodeError as exc:
            ad_adapter_destroy(adapter)
            fail(f"ad_snapshot() output is not valid JSON: {exc}\nraw: {raw_snap!r}")

        if snap_env.get("ok") is True:
            if expect_stub:
                ad_adapter_destroy(adapter)
                fail(
                    "ad_snapshot() returned ok:true but AD_EXPECT_STUB=1 — "
                    "the dylib appears to be built without --features stub-adapter; "
                    "a stub build cannot successfully complete a real snapshot"
                )
            # Real adapter succeeded (e.g. local run with AX grant + real adapter).
            ok("ad_snapshot() -> ok:true (real adapter path)")
        else:
            # Expected stub-adapter path: ok:false + PLATFORM_NOT_SUPPORTED.
            err = snap_env.get("error", {})
            code = err.get("code", "")
            if expect_stub and code != "PLATFORM_NOT_SUPPORTED":
                ad_adapter_destroy(adapter)
                fail(
                    f"ad_snapshot() envelope error.code = {code!r}, "
                    "expected 'PLATFORM_NOT_SUPPORTED' (stub adapter)"
                )
            ok(f"ad_snapshot() -> ok:false, error.code = {code!r}")
    else:
        # *out null means an argument/infrastructure error — rc is the code.
        ad_adapter_destroy(adapter)
        fail(
            f"ad_snapshot() set *out=null (rc={rc}); "
            "expected the error envelope to be written to *out"
        )

    ad_adapter_destroy(adapter)
    ok("ad_adapter_destroy() — no crash, no leak")

    if os.environ.get("AD_EXPECT_REAL") == "1":
        print("\nLeg 5 — real adapter snapshots a named app on the main and a worker thread")
        app = os.environ.get("AD_APP", "gnome-calculator").encode()
        adapter = ad_adapter_create()
        if not adapter:
            fail("ad_adapter_create() returned null for the real-adapter leg")

        def real_snapshot():
            out = c_char_p()
            rc = ad_snapshot(adapter, app, 0, 10, True, False, byref(out))
            raw = out.value
            if raw is not None:
                ad_free_string(out)
            if rc != 0:
                return False, f"ad_snapshot() returned rc={rc} (AD_RESULT code {rc})"
            try:
                envelope = json.loads(raw)
            except (TypeError, json.JSONDecodeError) as exc:
                return False, f"ad_snapshot() output is not valid JSON: {exc}"
            if envelope.get("ok") is not True:
                code = (envelope.get("error") or {}).get("code", "")
                return False, f"ad_snapshot() returned ok:false, error.code={code!r}"
            data = envelope.get("data") or {}
            if data.get("complete") is not True:
                return False, "ad_snapshot() returned an incomplete tree"
            if (data.get("ref_count") or 0) < 1:
                return False, "ad_snapshot() allocated no refs"
            return True, f"ref_count={data['ref_count']}"

        passed, message = real_snapshot()
        if not passed:
            ad_adapter_destroy(adapter)
            fail(f"real adapter snapshot on the main thread failed: {message}")
        ok(f"main thread: {app.decode()} snapshot ok:true {message}")

        worker_result = []

        def worker():
            worker_result.append(real_snapshot())

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(120)
        ad_adapter_destroy(adapter)
        if thread.is_alive() or not worker_result:
            fail("real adapter snapshot on a worker thread did not complete")
        passed, message = worker_result[0]
        if not passed:
            fail(f"real adapter snapshot on a worker thread failed: {message}")
        ok(f"worker thread: {app.decode()} snapshot ok:true {message}")

    if os.environ.get("AD_EXPECT_LINUX_HELPER") == "1":
        from linux_helper import verify
        try:
            verify(lib, os.environ["AD_HELPER_EMPTY_PATH"])
        except AssertionError as error:
            fail(str(error))
        ok("library-adjacent Linux owner set/read/clear with empty PATH")

    if os.environ.get("AD_EXPECT_MACOS_HELPER") == "1":
        print("\nLeg 6 — non-colocated Python host discovers the dylib-adjacent packaged helper")
        adapter = ad_adapter_create()
        if not adapter:
            fail("ad_adapter_create() returned null for helper discovery leg")
        clipboard = c_char_p()
        rc = ad_get_clipboard(adapter, byref(clipboard))
        if rc != 0:
            message = ad_last_error_message()
            helper_runtime_errors = {
                b"System clipboard is unavailable",
                b"System clipboard read access is denied",
            }
            if message in helper_runtime_errors:
                ad_adapter_destroy(adapter)
                ok(
                    "ctypes host reached the authenticated packaged helper; "
                    f"clipboard access was unavailable in this host ({message!r})"
                )
                print("\nAll legs passed.")
                return
            ad_adapter_destroy(adapter)
            fail(f"dylib-adjacent helper discovery failed rc={rc}: {message!r}")
        if clipboard.value is not None:
            ad_free_string(clipboard)
        ad_adapter_destroy(adapter)
        ok("ctypes host read clipboard through the packaged helper")

    print("\nAll legs passed.")


if __name__ == "__main__":
    main()
