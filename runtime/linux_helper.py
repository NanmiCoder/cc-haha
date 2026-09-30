#!/usr/bin/env python3
"""Linux (X11) Computer Use helper.

Uses mss / pyautogui / python-xlib / psutil / pyperclip to provide, on Linux
X11 desktops, the JSON command protocol the native macOS `cu-helper` daemon
and the Windows `win_helper.py` speak. This is the sole Python implementation
of that protocol on Linux.

Linux shares the mouse and keyboard with the user (there is no per-pid event
posting like macOS `CGEvent.postToPid`), and `pyautogui` reports success
unconditionally. So, mirroring the Windows helper, two delivery guards refuse
to send input when delivery is already known to be impossible:

  * `ensure_point_on_screen` refuses off-screen coordinates.
  * `ensure_target_window_reachable` refuses when the named app has no
    on-screen window to receive input.

`ForegroundLease` is intentionally simplified here: X11 has no low-level
global input hook as easy as the Windows WH_MOUSE_LL/WH_KEYBOARD_LL pair, so
the lease records the mutating command and foreground state but does not run a
physical-input monitor. The machine-readable error codes (user_interference /
target_window_offscreen / point_outside_display) are preserved so the caller's
retry policy is unchanged.

XWayland note: on XWayland sessions synthetic X input mostly works but window
state queries are less reliable; the guards fail open in that case.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

import mss  # noqa: E402
from PIL import Image  # noqa: E402

# The desktop app decodes helper stdout as UTF-8. Force UTF-8 at process start
# so JSON responses stay stable regardless of the user's system locale.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import pyautogui  # noqa: E402

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

DESKTOP_HOST_BUNDLE_ID = "com.claude-code-haha.desktop"

# ---------------------------------------------------------------------------
# Key mapping — Linux uses 'command' for the Super key
# ---------------------------------------------------------------------------
KEY_MAP = {
    "a": "a", "b": "b", "c": "c", "d": "d", "e": "e",
    "f": "f", "g": "g", "h": "h", "i": "i", "j": "j",
    "k": "k", "l": "l", "m": "m", "n": "n", "o": "o",
    "p": "p", "q": "q", "r": "r", "s": "s", "t": "t",
    "u": "u", "v": "v", "w": "w", "x": "x", "y": "y",
    "z": "z",
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    # Modifier keys — map macOS names to pyautogui equivalents
    "cmd": "command",
    "command": "command",
    "meta": "command",
    "super": "command",
    "win": "command",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "fn": "fn",
    # Navigation / editing
    "escape": "esc",
    "esc": "esc",
    "enter": "enter",
    "return": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "forwarddelete": "delete",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "home": "home",
    "end": "end",
    "pageup": "pageup",
    "pagedown": "pagedown",
    "capslock": "capslock",
    "insert": "insert",
    # Function keys
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
    "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
    "f9": "f9", "f10": "f10", "f11": "f11", "f12": "f12",
    # Symbols
    "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\",
    ";": ";", "'": "'", ",": ",", ".": ".", "/": "/", "`": "`",
}


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if key not in KEY_MAP:
        raise ValueError(f"Unsupported key: {name}")
    return KEY_MAP[key]


# ---------------------------------------------------------------------------
# JSON output helpers
# ---------------------------------------------------------------------------

def json_output(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def error_output(message: str, code: str = "runtime_error") -> None:
    json_output({"ok": False, "error": {"code": code, "message": message}})


def bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value not in {"0", "false", "False", ""}


# ---------------------------------------------------------------------------
# X11 helpers (python-xlib) — lazily opened
# ---------------------------------------------------------------------------

def _display():
    from Xlib.display import Display
    return Display(os.environ.get("DISPLAY", ":0"))


def _read_property_value(drawable: Any, atom_name: str, property_type: int, length: int):
    """Read a typed X property value (python-xlib get_property takes 4 args).

    The drawable's display back-ref is a `_BaseDisplay` proxy without
    `intern_atom`, so atom lookup goes through `get_atom` instead.
    """
    disp = drawable.display
    prop = drawable.get_property(disp.get_atom(atom_name), property_type, 0, length)
    if prop is None or not prop.value:
        return None
    return prop.value[0]

def _window_pid(window: Any) -> int | None:
    from Xlib import Xatom
    try:
        value = _read_property_value(window, "_NET_WM_PID", Xatom.CARDINAL, 1)
        if value is not None:
            return int(value)
    except Exception:
        pass
    return None


def _app_info_from_wm_class(window: Any) -> dict[str, str] | None:
    """Fallback app identity from WM_CLASS when no _NET_WM_PID is published.

    Many X11 toolkits (GTK/Nautilus, several browsers) never set the PID
    atom, so the instance/class pair is the only stable owner signal left.
    """
    try:
        cls = window.get_wm_class()
    except Exception:
        return None
    if not cls:
        return None
    instance, app_class = cls[0], cls[1] if len(cls) > 1 else cls[0]
    name = app_class or instance or window.get_wm_name() or ""
    if not name:
        return None
    stem = name
    if stem.casefold() == "claude code haha":
        bundle_id = DESKTOP_HOST_BUNDLE_ID
    else:
        bundle_id = stem
    return {"bundleId": bundle_id, "displayName": name}


def _app_info_from_pid(pid: int | None) -> dict[str, str] | None:
    if not pid:
        return None
    try:
        import psutil
        proc = psutil.Process(pid)
        exe = proc.exe() or ""
        name = proc.name() or ""
        stem = Path(exe).stem if exe else Path(name).stem
        if stem.casefold() == "claude code haha":
            bundle_id = DESKTOP_HOST_BUNDLE_ID
        else:
            bundle_id = stem
        return {"bundleId": bundle_id, "displayName": name}
    except Exception:
        return None


def _app_info_for_window(window: Any) -> dict[str, str] | None:
    """Resolve the owning app, walking up to the top-level owner if needed.

    Prefers the _NET_WM_PID + psutil route (real process identity). When that
    yields nothing, falls back to WM_CLASS so GTK/Nautilus-style windows that
    publish no PID atom still report an owning app.
    """
    w = window
    for _ in range(12):
        info = _app_info_from_pid(_window_pid(w))
        if info:
            return info
        try:
            parent = w.get_wm_parent()
        except Exception:
            parent = None
        if not parent:
            break
        w = parent
    return _app_info_from_wm_class(w)

def _is_iconic(window: Any) -> bool | None:
    """True if minimized, False if normal, None if state is unreadable."""
    try:
        st = window.get_wm_state()
        if st:
            return int(st[0]) == 4  # Iconic
    except Exception:
        pass
    return None


def _top_level_windows() -> list[dict[str, Any]]:
    """Visible top-level windows with app info and geometry."""
    out: list[dict[str, Any]] = []
    try:
        d = _display()
        root = d.screen().root
        children = root.query_tree().children
    except Exception:
        return out
    for w in children:
        try:
            if w.get_wm_name() is None:
                continue  # skip non-application windows (panels, cursors, ...)
            geom = w.get_geometry()
            if geom.width <= 0 or geom.height <= 0:
                continue
            out.append({
                "window": w,
                "app": _app_info_for_window(w),
                "iconic": _is_iconic(w),
                "geom": {
                    "x": geom.x,
                    "y": geom.y,
                    "width": geom.width,
                    "height": geom.height,
                },
            })
        except Exception:
            continue
    return out


def list_windows() -> list[dict[str, Any]]:
    """List visible on-screen windows with their bounds."""
    results: list[dict[str, Any]] = []
    for w in _top_level_windows():
        try:
            title = w["window"].get_wm_name() or ""
        except Exception:
            title = ""
        results.append({
            "title": title,
            "bounds": w["geom"],
            "ownerName": w["app"]["displayName"] if w["app"] else "",
            "bundleId": w["app"]["bundleId"] if w["app"] else "",
            "iconic": w["iconic"],
        })
    return results


# ---------------------------------------------------------------------------
# Display / Monitor helpers (mss)
# ---------------------------------------------------------------------------

def get_displays() -> list[dict[str, Any]]:
    """Enumerate monitors via mss. Scale factor is 1.0 (X11 is physical px)."""
    displays: list[dict[str, Any]] = []
    try:
        with mss.mss() as sct:
            monitors = sct.monitors
    except Exception:
        return displays
    # monitors[0] is the combined virtual screen; [1:] are the real ones.
    for idx, m in enumerate(monitors[1:]):
        name = f"Display {idx + 1}"
        displays.append({
            "id": idx,
            "displayId": idx,
            "width": m["width"],
            "height": m["height"],
            "scaleFactor": 1.0,
            "originX": m["left"],
            "originY": m["top"],
            "isPrimary": idx == 0,
            "name": name,
            "label": name,
        })
    return displays


def choose_display(display_id: int | None) -> dict[str, Any]:
    displays = get_displays()
    if not displays:
        raise RuntimeError("No active displays found")
    if display_id is None:
        for display in displays:
            if display["isPrimary"]:
                return display
        return displays[0]
    for display in displays:
        if display["displayId"] == display_id or display["id"] == display_id:
            return display
    raise RuntimeError(f"Unknown display: {display_id}")


# ---------------------------------------------------------------------------
# Screen capture (mss)
# ---------------------------------------------------------------------------

def capture_display(display_id: int | None, resize: tuple[int, int] | None = None) -> dict[str, Any]:
    display = choose_display(display_id)
    monitor = {
        "left": display["originX"],
        "top": display["originY"],
        "width": display["width"],
        "height": display["height"],
    }
    with mss.mss() as sct:
        raw = sct.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {
        "base64": base64_data,
        "width": image.width,
        "height": image.height,
        "displayWidth": display["width"],
        "displayHeight": display["height"],
        "displayId": display["displayId"],
        "originX": display["originX"],
        "originY": display["originY"],
        "display": display,
    }


def capture_region(region: dict[str, int], resize: tuple[int, int] | None = None) -> dict[str, Any]:
    with mss.mss() as sct:
        raw = sct.grab(region)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"base64": base64_data, "width": image.width, "height": image.height}


# ---------------------------------------------------------------------------
# Application enumeration (XDG .desktop + psutil + X11)
# ---------------------------------------------------------------------------

def _desktop_files() -> list[Path]:
    candidates: list[Path] = []
    roots = [
        Path.home() / ".local" / "share" / "applications",
        Path("/usr/local/share/applications"),
        Path("/usr/share/applications"),
    ]
    for root in roots:
        try:
            if root.is_dir():
                candidates.extend(sorted(root.glob("*.desktop")))
        except Exception:
            continue
    return candidates


def _desktop_entry(path: Path) -> dict[str, str] | None:
    """Minimal INI read of a .desktop file: Name, Exec, path."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    name = ""
    exe = ""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Name="):
            name = line[len("Name="):]
        elif line.startswith("Exec="):
            exe = line[len("Exec="):]
    if not name:
        name = path.stem
    return {"name": name, "exec": exe.strip(), "path": str(path)}


def installed_apps() -> list[dict[str, Any]]:
    """List XDG .desktop applications."""
    results: dict[str, dict[str, Any]] = {}
    for path in _desktop_files():
        entry = _desktop_entry(path)
        if not entry:
            continue
        bundle_id = path.stem
        if bundle_id not in results:
            results[bundle_id] = {
                "bundleId": bundle_id,
                "displayName": entry["name"],
                "path": entry["path"],
            }
    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def running_apps() -> list[dict[str, Any]]:
    """List running GUI applications (apps owning top-level windows)."""
    seen: dict[str, dict[str, str]] = {}
    for w in _top_level_windows():
        app = w["app"]
        if not app:
            continue
        seen[app["bundleId"]] = {
            "bundleId": app["bundleId"],
            "displayName": app["displayName"],
        }
    return sorted(seen.values(), key=lambda item: item["displayName"].lower())


def app_display_name(bundle_id: str) -> str | None:
    """Find display name for a given bundleId (desktop stem or exe stem)."""
    for w in _top_level_windows():
        app = w["app"]
        if app and app["bundleId"].lower() == bundle_id.lower():
            return app["displayName"]
    entry = _desktop_entry(Path(f"{bundle_id}.desktop"))
    if entry:
        return entry["name"]
    return None


def _windows_for_bundle(bundle_id: str) -> list[Any]:
    """Every top-level window whose app bundle matches; None if no windows."""
    wanted = bundle_id.strip().lower()
    if not wanted:
        return []
    handles = [
        w["window"] for w in _top_level_windows()
        if w["app"] and w["app"]["bundleId"].lower() == wanted
    ]
    return handles


def _foreground_existing_app(bundle_id: str) -> bool:
    """Bring the frontmost matching visible window forward if one exists."""
    wanted = bundle_id.casefold()
    matches = [
        w["window"] for w in _top_level_windows()
        if w["app"] and w["app"]["bundleId"].casefold() == wanted
        and w["iconic"] is not True
    ]
    if not matches:
        return False
    try:
        d = _display()
        window = matches[0]
        if window.get_wm_state() and int(window.get_wm_state()[0]) == 4:
            window.map()
        window.configure(window_properties={"stack_mode": 1})  # above
        window.raise_window()
        try:
            window.input_focus(2)  # PointerRoot-ish; force activate
        except Exception:
            pass
        d.sync()
        return True
    except Exception:
        return False


def _net_active_window():
    """EWMH _NET_ACTIVE_WINDOW on the root — more stable than input focus."""
    from Xlib import Xatom
    try:
        d = _display()
        root = d.screen().root
        value = _read_property_value(root, "_NET_ACTIVE_WINDOW", Xatom.WINDOW, 1)
        if value is not None:
            return d.create_resource_object("window", int(value))
    except Exception:
        pass
    return None


def frontmost_app() -> dict[str, str] | None:
    """Get the currently focused (foreground) application.

    Prefers the EWMH _NET_ACTIVE_WINDOW hint (composers publish it reliably);
    falls back to the raw input-focus event, which can legitimately be
    PointerRoot/None on some desktops.
    """
    try:
        d = _display()
        window = _net_active_window()
        if window is None:
            event = d.get_input_focus()
            data = getattr(event, "data", None) or {}
            window = data.get("focus")
        if window is None or str(window).lower() in {"0x0", "pointerroot", "none"}:
            return None
        return _app_info_for_window(window)
    except Exception:
        return None


def app_under_point(x: int, y: int) -> dict[str, str] | None:
    """Find the app whose window is under the given screen coordinate."""
    try:
        d = _display()
        root = d.screen().root
        window = root.childwindow(x, y)
        if window:
            info = _app_info_for_window(window)
            if info:
                return info
    except Exception:
        pass
    return frontmost_app()


def find_window_displays(bundle_ids: list[str]) -> list[dict[str, Any]]:
    """For each bundleId, find which display(s) its windows are on."""
    if not bundle_ids:
        return []
    displays = get_displays()
    windows = _top_level_windows()
    result = []
    for bundle_id in bundle_ids:
        want = bundle_id.lower()
        display_ids: set[int] = set()
        for w in windows:
            app = w["app"]
            if not app or app["bundleId"].lower() != want:
                continue
            wx, wy = w["geom"]["x"], w["geom"]["y"]
            ww, wh = w["geom"]["width"], w["geom"]["height"]
            for display in displays:
                dx, dy = display["originX"], display["originY"]
                dw, dh = display["width"], display["height"]
                if wx < dx + dw and wx + ww > dx and wy < dy + dh and wy + wh > dy:
                    display_ids.add(int(display["displayId"]))
        result.append({"bundleId": bundle_id, "displayIds": sorted(display_ids)})
    return result


def open_app(bundle_id: str) -> None:
    """Open an application by its bundleId (desktop stem or executable name)."""
    if _foreground_existing_app(bundle_id):
        return

    # Find the Exec line from a matching .desktop file.
    for path in _desktop_files():
        if path.stem.lower() == bundle_id.lower():
            entry = _desktop_entry(path)
            if entry and entry["exec"]:
                # Strip field codes like %u/%f/%k — run the bare command.
                cmd = entry["exec"].split("%")[0].strip()
                if cmd:
                    try:
                        subprocess.Popen(
                            cmd,
                            shell=True,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL,
                        )
                        return
                    except Exception:
                        pass

    # Fallback: try to run it directly by name.
    try:
        subprocess.Popen(
            [bundle_id],
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        raise RuntimeError(f"App not found for identifier: {bundle_id}")


# ---------------------------------------------------------------------------
# Clipboard (pyperclip — requires xclip or xsel on Linux)
# ---------------------------------------------------------------------------

def read_clipboard() -> str:
    import pyperclip
    try:
        return pyperclip.paste() or ""
    except Exception:
        return ""


def write_clipboard(text: str) -> None:
    import pyperclip
    pyperclip.copy(text)


def paste_clipboard() -> None:
    pyautogui.hotkey("ctrl", "v")


# ---------------------------------------------------------------------------
# Input guards — refuse rather than report a lie
# ---------------------------------------------------------------------------

class UserInterference(RuntimeError):
    """The user touched the physical mouse or keyboard during an action."""

    def __init__(self, message: str, code: str = "user_interference") -> None:
        super().__init__(message)
        self.code = code


class InputMonitorUnavailable(RuntimeError):
    """The (simplified) foreground monitor is unavailable."""

    def __init__(self, message: str, code: str = "user_interference_result_unknown") -> None:
        super().__init__(message)
        self.code = code


class InputInjectionFailed(RuntimeError):
    """The injected input could not be sent."""

    def __init__(self, message: str, code: str = "input_injection_failed") -> None:
        super().__init__(message)
        self.code = code


class DeliveryRefused(RuntimeError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class ForegroundLease:
    """Simplified Linux lease.

    X11 lacks the low-level global input hook the Windows helper uses, so this
    records the mutating command and the foreground app before/after, but does
    not monitor physical input. It keeps the same interface (acquire /
    mark_started / finalize / close) so the dispatcher reads identically.
    """

    def __init__(self, command: str) -> None:
        self.command = command
        self._closed = False

    def acquire(self) -> None:
        pass

    def mark_started(self) -> None:
        pass

    def finalize(self) -> None:
        pass

    def close(self) -> None:
        self._closed = True


def _virtual_screen_rect() -> tuple[int, int, int, int] | None:
    """(left, top, right, bottom) across all monitors, or None if unavailable."""
    try:
        displays = get_displays()
        if not displays:
            return None
        left = min(d["originX"] for d in displays)
        top = min(d["originY"] for d in displays)
        right = max(d["originX"] + d["width"] for d in displays)
        bottom = max(d["originY"] + d["height"] for d in displays)
        if right - left <= 0 or bottom - top <= 0:
            return None
        return (left, top, right, bottom)
    except Exception:
        return None


def ensure_point_on_screen(x: int, y: int) -> None:
    """Refuse coordinates outside every monitor (fails open if unreadable)."""
    rect = _virtual_screen_rect()
    if rect is None:
        return
    left, top, right, bottom = rect
    if left <= x < right and top <= y < bottom:
        return
    raise DeliveryRefused(
        f"The point ({x}, {y}) is outside every display "
        f"(virtual screen is {left},{top} to {right},{bottom}), so the action "
        "was not sent. Take a screenshot to get current coordinates.",
        code="point_outside_display",
    )


def ensure_target_window_reachable(bundle_id: str | None) -> None:
    """Refuse when the named app's windows are all minimized/hidden.

    Fails open when the app owns no top-level windows at all — that is a
    different failure (wrong app name, app not running) which the caller's own
    resolution step reports with a better message.
    """
    if not bundle_id:
        return
    windows = [
        w for w in _top_level_windows()
        if w["app"] and w["app"]["bundleId"].lower() == bundle_id.lower()
    ]
    if not windows:
        return
    if all(w["iconic"] is True for w in windows):
        raise DeliveryRefused(
            "The target app has no window that input can reach — it is "
            "minimized. The action was NOT sent. Restore the window and try "
            "again.",
            code="target_window_offscreen",
        )


# ---------------------------------------------------------------------------
# Input actions (pyautogui — X11)
# ---------------------------------------------------------------------------

def _move_cursor_to(x: int, y: int, animate: bool = True) -> None:
    duration = 0.15 if animate else 0.0
    pyautogui.moveTo(x, y, duration=duration)


def click(
    x: int,
    y: int,
    button: str,
    count: int,
    modifiers: list[str] | None,
    animate: bool = True,
) -> None:
    buttons = {"left": "left", "right": "right", "middle": "middle"}
    if button not in buttons:
        raise ValueError(f"Unsupported mouse button: {button}")
    normalized = [normalize_key(m) for m in (modifiers or [])]
    _move_cursor_to(x, y, animate)
    for key in normalized:
        pyautogui.keyDown(key)
    try:
        pyautogui.click(x, y, button=buttons[button], clicks=max(1, count))
    finally:
        for key in reversed(normalized):
            pyautogui.keyUp(key)


def scroll(
    x: int,
    y: int,
    delta_x: int,
    delta_y: int,
    animate: bool = True,
) -> None:
    _move_cursor_to(x, y, animate)
    if delta_y:
        pyautogui.scroll(int(delta_y))
    if delta_x:
        try:
            pyautogui.hscroll(int(delta_x))
        except Exception:
            pass


def key_action(sequence: str, repeat: int = 1) -> None:
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    for _ in range(max(1, repeat)):
        if len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts)
        time.sleep(0.01)


def hold_keys(keys: list[str], duration_ms: int) -> None:
    normalized = [normalize_key(k) for k in keys]
    for key in normalized:
        pyautogui.keyDown(key)
    try:
        time.sleep(max(duration_ms, 0) / 1000)
    finally:
        for key in reversed(normalized):
            pyautogui.keyUp(key)


def type_text(text: str) -> None:
    # One process, one lease per complete type action (mirrors the Windows
    # helper). Newline and tab remain real key presses; everything else is
    # written one character at a time so Unicode survives.
    index = 0
    while index < len(text):
        character = text[index]
        if character in {"\r", "\n", "\t"}:
            if character == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
                index += 1
            pyautogui.press("tab" if character == "\t" else "enter")
        else:
            pyautogui.write(character, interval=0.025)
        index += 1


# ---------------------------------------------------------------------------
# Main dispatcher — the command protocol the Windows helper also speaks
# ---------------------------------------------------------------------------

MUTATING_COMMANDS = frozenset({
    "click", "drag", "move_mouse", "scroll",
    "mouse_down", "mouse_up",
    "key", "hold_key", "type",
    "paste_clipboard",
})

COORDINATE_COMMANDS = frozenset({"click", "drag", "move_mouse", "scroll"})


def _coordinate_of(command: str, payload: dict[str, Any]) -> tuple[int, int] | None:
    if command not in COORDINATE_COMMANDS:
        return None
    if command == "drag":
        target = payload.get("to") or {}
        if "x" in target and "y" in target:
            return int(target["x"]), int(target["y"])
        return None
    if "x" in payload and "y" in payload:
        return int(payload["x"]), int(payload["y"])
    return None


def _finish(lease: "ForegroundLease | None", result: Any) -> int:
    if lease is not None:
        lease.finalize()
        lease.close()
    json_output({"ok": True, "result": result})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()
    payload = json.loads(args.payload)

    lease: ForegroundLease | None = None

    try:
        command = args.command

        if command in MUTATING_COMMANDS:
            point = _coordinate_of(command, payload)
            if point is not None:
                ensure_point_on_screen(point[0], point[1])
            ensure_target_window_reachable(
                payload.get("bundleId") or payload.get("app")
            )
            lease = ForegroundLease(command)
            lease.acquire()
            lease.mark_started()
        if command == "check_permissions":
            json_output({"ok": True, "result": check_permissions()})
            return 0
        if command == "list_displays":
            json_output({"ok": True, "result": get_displays()})
            return 0
        if command == "get_display_size":
            json_output({"ok": True, "result": choose_display(payload.get("displayId"))})
            return 0
        if command == "screenshot":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("displayId"), resize)
            json_output({"ok": True, "result": result})
            return 0
        if command == "resolve_prepare_capture":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("preferredDisplayId"), resize)
            result["hidden"] = []
            result["resolvedDisplayId"] = result["displayId"]
            json_output({"ok": True, "result": result})
            return 0
        if command == "zoom":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            region = {
                "left": int(payload["x"]),
                "top": int(payload["y"]),
                "width": int(payload["width"]),
                "height": int(payload["height"]),
            }
            json_output({"ok": True, "result": capture_region(region, resize)})
            return 0
        if command == "prepare_for_action":
            json_output({"ok": True, "result": []})
            return 0
        if command == "preview_hide_set":
            json_output({"ok": True, "result": []})
            return 0
        if command == "find_window_displays":
            json_output({"ok": True, "result": find_window_displays(list(payload.get("bundleIds") or []))})
            return 0
        if command == "key":
            key_action(str(payload["keySequence"]), int(payload.get("repeat") or 1))
            return _finish(lease, True)
        if command == "hold_key":
            hold_keys(list(payload.get("keyNames") or []), int(payload.get("durationMs") or 0))
            return _finish(lease, True)
        if command == "type":
            type_text(str(payload.get("text") or ""))
            return _finish(lease, True)
        if command == "click":
            click(int(payload["x"]), int(payload["y"]), str(payload.get("button") or "left"), int(payload.get("count") or 1), payload.get("modifiers"), bool(payload.get("animate", True)))
            return _finish(lease, True)
        if command == "drag":
            from_point = payload.get("from")
            if from_point is None:
                current = pyautogui.position()
                start_x, start_y = int(current.x), int(current.y)
            else:
                start_x = int(from_point["x"])
                start_y = int(from_point["y"])
            target_x = int(payload["to"]["x"])
            target_y = int(payload["to"]["y"])
            animate = bool(payload.get("animate", True))
            _move_cursor_to(start_x, start_y, animate)
            pyautogui.mouseDown()
            _move_cursor_to(target_x, target_y, animate)
            pyautogui.mouseUp()
            return _finish(lease, True)
        if command == "move_mouse":
            _move_cursor_to(int(payload["x"]), int(payload["y"]), bool(payload.get("animate", True)))
            return _finish(lease, True)
        if command == "scroll":
            scroll(int(payload["x"]), int(payload["y"]), int(payload.get("deltaX") or 0), int(payload.get("deltaY") or 0), bool(payload.get("animate", True)))
            return _finish(lease, True)
        if command == "mouse_down":
            pyautogui.mouseDown()
            return _finish(lease, True)
        if command == "mouse_up":
            pyautogui.mouseUp()
            return _finish(lease, True)
        if command == "cursor_position":
            x, y = pyautogui.position()
            json_output({"ok": True, "result": {"x": int(x), "y": int(y)}})
            return 0
        if command == "frontmost_app":
            json_output({"ok": True, "result": frontmost_app()})
            return 0
        if command == "app_under_point":
            json_output({"ok": True, "result": app_under_point(int(payload["x"]), int(payload["y"]))})
            return 0
        if command == "list_installed_apps":
            json_output({"ok": True, "result": installed_apps()})
            return 0
        if command == "list_running_apps":
            json_output({"ok": True, "result": running_apps()})
            return 0
        if command == "open_app":
            open_app(str(payload["bundleId"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "read_clipboard":
            json_output({"ok": True, "result": read_clipboard()})
            return 0
        if command == "write_clipboard":
            write_clipboard(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        if command == "paste_clipboard":
            paste_clipboard()
            return _finish(lease, True)
        error_output(f"Unknown command: {command}", code="bad_command")
        return 2
    except (
        UserInterference,
        DeliveryRefused,
        InputMonitorUnavailable,
        InputInjectionFailed,
    ) as exc:
        error_output(str(exc), code=exc.code)
        return 1
    except Exception as exc:
        error_output(str(exc))
        return 1
    finally:
        if lease is not None:
            try:
                lease.close()
            except (UserInterference, InputMonitorUnavailable):
                pass


def check_permissions() -> dict[str, bool | None]:
    """Linux does not require explicit accessibility/screen-recording
    permissions like macOS TCC. Always report as granted."""
    return {
        "accessibility": True,
        "screenRecording": True,
    }


if __name__ == "__main__":
    raise SystemExit(main())

