"""Verify Linux owner discovery from a foreign host with an empty PATH."""
import ctypes
import os
import json
import subprocess
import sys


def read_foreign_text():
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, Gtk
    Gtk.init([])
    return Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text()


def verify(lib, empty_path, reader=read_foreign_text):
    signatures = {
        "ad_adapter_create": (ctypes.c_void_p, []),
        "ad_adapter_destroy": (None, [ctypes.c_void_p]),
        "ad_set_clipboard": (ctypes.c_int, [ctypes.c_void_p, ctypes.c_char_p]),
        "ad_clear_clipboard": (ctypes.c_int, [ctypes.c_void_p]),
        "ad_last_error_message": (ctypes.c_char_p, []),
    }
    for name, (result, args) in signatures.items():
        function = getattr(lib, name)
        function.restype, function.argtypes = result, args
    original_path = os.environ.get("PATH")
    payload = b"agent-desktop-library-adjacent-owner"
    adapter = None
    written = False
    try:
        os.environ["PATH"] = empty_path
        adapter = lib.ad_adapter_create()
        if not adapter:
            raise AssertionError("helper probe could not create adapter")
        rc = lib.ad_set_clipboard(adapter, payload)
        lib.ad_adapter_destroy(adapter)
        adapter = None
        if rc != 0:
            raise AssertionError(f"packaged owner set failed rc={rc}: {lib.ad_last_error_message()!r}")
        written = True
        if reader() != payload.decode():
            raise AssertionError("foreign GTK reader did not receive the owner payload after adapter destruction")
        adapter = lib.ad_adapter_create()
        if not adapter:
            raise AssertionError("helper probe could not create clear adapter")
        rc = lib.ad_clear_clipboard(adapter)
        if rc != 0:
            raise AssertionError(f"packaged owner clear failed rc={rc}: {lib.ad_last_error_message()!r}")
        if reader() is not None:
            raise AssertionError("foreign GTK reader still sees a cleared selection")
        written = False
    finally:
        if written:
            if adapter is None:
                adapter = lib.ad_adapter_create()
            if adapter:
                lib.ad_clear_clipboard(adapter)
        if adapter:
            lib.ad_adapter_destroy(adapter)
        if original_path is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = original_path


def verify_cli(entry, empty_path, reader=read_foreign_text, run=subprocess.run):
    payload = "agent-desktop-installed-owner"
    env = dict(os.environ, PATH=empty_path)
    def command(*args):
        result = run([entry, *args], env=env, capture_output=True,
                     text=True, timeout=15, check=False)
        if result.returncode != 0 or json.loads(result.stdout).get("ok") is not True:
            raise AssertionError(f"installed clipboard command failed: {args[0]}: {result.stdout} {result.stderr}")
    written = False
    try:
        command("clipboard-set", payload)
        written = True
        if reader() != payload:
            raise AssertionError("installed owner payload did not reach the foreign reader")
        command("clipboard-clear")
        if reader() is not None:
            raise AssertionError("installed clear left a selection")
        written = False
    finally:
        if written:
            command("clipboard-clear")


if __name__ == "__main__":
    verify_cli(*sys.argv[1:])
    print("installed owner set/read/clear passed with empty PATH")
