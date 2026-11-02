from __future__ import annotations

import ctypes
import ctypes.util

from oracle import atspi_raw
from runner import apps
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.headed_actions import (
    assert_ok,
    live_root,
    longest_text,
    ref_for,
    restore_text,
    window_of,
)


def held_modifiers(text: str) -> list[str]:
    held, seen = [], set()
    for line in text.splitlines():
        name, sep, state = line.partition(":")
        name, state = name.strip(), state.strip().lower()
        if not sep or name in seen or name not in MODIFIERS or state not in ("off", "up", "on", "down"):
            raise AssertionError(f"invalid modifier oracle state: {text!r}")
        seen.add(name)
        if state in ("on", "down"):
            held.append(name)
    if seen != set(MODIFIERS):
        raise AssertionError("incomplete modifier oracle state")
    return held


def _launch(ctx: LegContext):
    app = apps.launch(ctx.tier, "Text Editor")
    return app, window_of(app)


@implementation("text_entry.typed_text_reaches_document")
def typed_text_reaches_document(ctx: LegContext) -> None:
    app, window = _launch(ctx)
    try:
        before = longest_text(live_root(ctx.tier, app))
        ctx.before("atspi.document_text", before)
        assert_ok(ctx.product(["type", ref_for(ctx, window, role="textfield"), "typed words"]))
        after = atspi_raw.poll(
            lambda: longest_text(live_root(ctx.tier, app))
            if "typed words" in longest_text(live_root(ctx.tier, app))
            else None,
            6.0,
        )
        ctx.after("atspi.document_text", after)
        if not after:
            raise AssertionError("typed text did not reach the document")
        restore_text(ctx, app, before)
    finally:
        apps.stop(app)


MODIFIERS = {"Shift": (0xffe1, 0xffe2), "Control": (0xffe3, 0xffe4),
             "Alt": (0xffe9, 0xffea), "Super": (0xffeb, 0xffec)}


def _modifier_state(tier) -> str:
    library = ctypes.util.find_library("X11")
    if not library:
        raise AssertionError("modifier oracle needs libX11")
    xlib = ctypes.CDLL(library)
    xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
    xlib.XOpenDisplay.restype = ctypes.c_void_p
    xlib.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    xlib.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    xlib.XKeysymToKeycode.restype = ctypes.c_ubyte
    xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = xlib.XOpenDisplay(tier.env["DISPLAY"].encode())
    if not display:
        raise AssertionError("modifier oracle could not open the private display")
    try:
        keys = (ctypes.c_ubyte * 32)()
        if not xlib.XQueryKeymap(display, keys):
            raise AssertionError("modifier oracle keymap query failed")
        result = []
        for name, symbols in MODIFIERS.items():
            codes = [xlib.XKeysymToKeycode(display, symbol) for symbol in symbols]
            if any(code <= 0 or code >= 256 for code in codes):
                raise AssertionError(f"modifier oracle has no keycode for {name}")
            down = any(keys[code // 8] & (1 << (code % 8)) for code in codes)
            result.append(f"{name}: {'on' if down else 'off'}")
        return "\n".join(result)
    finally:
        xlib.XCloseDisplay(display)


@implementation("text_entry.held_key_released")
def held_key_released(ctx: LegContext) -> None:
    app, window = _launch(ctx)
    try:
        ctx.before("x11.modifiers", held_modifiers(_modifier_state(ctx.tier)))
        assert_ok(ctx.product(["press", "shift+a", "--window-id", window]))
        after = held_modifiers(_modifier_state(ctx.tier))
        ctx.after("x11.modifiers", after)
        if after:
            raise AssertionError("a modifier was left pressed after the key combo")
        ctx.restored("x11.modifiers", held_modifiers(_modifier_state(ctx.tier)))
    finally:
        apps.stop(app)


def press_verdict(typed: str, after_return: str, after_clear: str, stuck: list[str]) -> list[str]:
    problems = []
    if "ab" not in typed:
        problems.append("semantic type did not reach the document")
    if after_return.count("\n") != typed.count("\n") + 1:
        problems.append("press return did not insert exactly one newline")
    if after_clear != "":
        problems.append(f"ctrl+a then backspace left {after_clear!r}")
    if stuck:
        problems.append(f"modifiers left down: {stuck}")
    return problems


def _settled_document(read, accepted) -> str:
    atspi_raw.poll(lambda: accepted(read()), 6.0)
    return read()


@implementation("text_entry.press_combos_edit_document")
def press_combos_edit_document(ctx: LegContext) -> None:
    app, window = _launch(ctx)
    try:
        read = lambda: longest_text(live_root(ctx.tier, app))
        before = read()
        ctx.before("atspi.document_text", before)
        ctx.before("x11.modifiers", held_modifiers(_modifier_state(ctx.tier)))
        assert_ok(ctx.product(["type", ref_for(ctx, window, role="textfield"), "ab"]))
        typed = _settled_document(read, lambda text: "ab" in text)
        assert_ok(ctx.product(["press", "return", "--window-id", window]))
        after_return = _settled_document(read, lambda text: text.count("\n") == typed.count("\n") + 1)
        assert_ok(ctx.product(["press", "ctrl+a", "--window-id", window]))
        assert_ok(ctx.product(["press", "backspace", "--window-id", window]))
        after_clear = _settled_document(read, lambda text: text == "")
        ctx.after("atspi.document_text", after_clear)
        stuck = held_modifiers(_modifier_state(ctx.tier))
        ctx.after("x11.modifiers", stuck)
        problems = press_verdict(typed, after_return, after_clear, stuck)
        if problems:
            raise AssertionError("; ".join(problems))
        restore_text(ctx, app, before)
        ctx.restored("x11.modifiers", held_modifiers(_modifier_state(ctx.tier)))
    finally:
        apps.stop(app)
