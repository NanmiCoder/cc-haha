#!/usr/bin/env python3
"""Windows Computer Use helper.

Uses win32gui / win32api / win32process / psutil / pyperclip / screeninfo /
pyautogui to provide, on Windows, the JSON command protocol the native macOS
`cu-helper` daemon speaks. macOS is native-only — there is no Python path there
— so this is the sole implementation of that protocol in Python.

One difference is not an implementation detail and shapes everything below:
macOS delivers input with `CGEvent.postToPid`, straight into the target
process, leaving the real cursor and the foreground app alone. Windows has no
equivalent. `pyautogui` uses Windows' synthetic-input APIs, which inject into
system-wide input stream and warp the one real cursor. The agent therefore
shares the mouse and keyboard with the user, and cannot verify that anything
it sent arrived.

Hence the two mechanisms that have no macOS counterpart:

  * `ForegroundLease` aborts when physical input overlaps an action, because
    interleaved streams produce clicks neither party intended.
  * `ensure_point_on_screen` / `ensure_target_window_reachable` refuse to send
    at all when delivery is already known to be impossible.

Both exist because `SendInput` reports success unconditionally, and "Action
completed" for input that went nowhere is worse than an error.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from io import BytesIO
from pathlib import Path
from typing import Any

import mss
from PIL import Image


DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)


def _enable_per_monitor_dpi_awareness() -> None:
    """Keep capture, SendInput, and overlay coordinates in physical pixels."""
    try:
        setter = ctypes.windll.user32.SetProcessDpiAwarenessContext
        setter.argtypes = [wintypes.HANDLE]
        setter.restype = wintypes.BOOL
        if setter(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
            return
    except (AttributeError, OSError):
        pass
    try:
        shcore = ctypes.windll.shcore
        shcore.SetProcessDpiAwareness.argtypes = [ctypes.c_int]
        shcore.SetProcessDpiAwareness.restype = ctypes.c_long
        if shcore.SetProcessDpiAwareness(2) in (0, 0x80070005):
            return
    except (AttributeError, OSError):
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


_enable_per_monitor_dpi_awareness()

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

import pyautogui  # noqa: E402

# The desktop app decodes helper stdout as UTF-8. On Windows, redirected Python
# stdout defaults to the active ANSI code page (for example GBK), which mangles
# localized app names from the registry. Force UTF-8 at process start so JSON
# responses stay stable regardless of the user's system locale.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

DESKTOP_HOST_BUNDLE_ID = "com.claude-code-haha.desktop"

# ---------------------------------------------------------------------------
# Key mapping — Windows uses 'win' instead of 'command'
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
    # Modifier keys — map macOS names to Windows equivalents
    "cmd": "win",
    "command": "win",
    "meta": "win",
    "super": "win",
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
# Display / Monitor helpers (via screeninfo + ctypes)
# ---------------------------------------------------------------------------

def get_displays() -> list[dict[str, Any]]:
    """Enumerate monitors via screeninfo, with DPI scale from ctypes."""
    from screeninfo import get_monitors

    displays: list[dict[str, Any]] = []
    for idx, m in enumerate(get_monitors()):
        scale_factor = _get_monitor_scale(m)
        name = m.name or f"Display {idx + 1}"
        displays.append({
            "id": idx,
            "displayId": idx,
            "width": m.width,
            "height": m.height,
            "scaleFactor": scale_factor,
            "originX": m.x,
            "originY": m.y,
            "isPrimary": m.is_primary if hasattr(m, "is_primary") else (idx == 0),
            "name": name,
            "label": name,
        })
    return displays


def _get_monitor_scale(monitor: Any) -> float:
    """Get one monitor's effective DPI scale. Returns 1.0 on failure."""
    try:
        user = ctypes.windll.user32
        shcore = ctypes.windll.shcore
        user.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
        user.MonitorFromPoint.restype = wintypes.HMONITOR
        shcore.GetDpiForMonitor.argtypes = [
            wintypes.HMONITOR,
            ctypes.c_int,
            ctypes.POINTER(wintypes.UINT),
            ctypes.POINTER(wintypes.UINT),
        ]
        shcore.GetDpiForMonitor.restype = ctypes.c_long
        point = wintypes.POINT(
            int(monitor.x + monitor.width / 2),
            int(monitor.y + monitor.height / 2),
        )
        handle = user.MonitorFromPoint(point, 2)  # MONITOR_DEFAULTTONEAREST
        dpi_x = wintypes.UINT(96)
        dpi_y = wintypes.UINT(96)
        if handle and shcore.GetDpiForMonitor(
            handle, 0, ctypes.byref(dpi_x), ctypes.byref(dpi_y)
        ) == 0:
            return max(1.0, float(dpi_x.value) / 96.0)
    except Exception:
        pass
    return 1.0


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
# Window management (win32gui)
# ---------------------------------------------------------------------------

def list_windows() -> list[dict[str, Any]]:
    """List visible on-screen windows with their bounds."""
    import win32gui

    results: list[dict[str, Any]] = []

    def _enum_cb(hwnd: int, _: Any) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        except Exception:
            return
        width = right - left
        height = bottom - top
        if width <= 1 or height <= 1:
            return
        # Get the process name as owner
        owner = _get_window_process_name(hwnd)
        results.append({
            "ownerName": owner,
            "title": title,
            "bounds": {"x": left, "y": top, "width": width, "height": height},
        })

    win32gui.EnumWindows(_enum_cb, None)
    return results


def _get_window_process_name(hwnd: int) -> str:
    """Get the exe name of the process owning a window handle."""
    try:
        return _window_process(hwnd).name()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Application management
# ---------------------------------------------------------------------------

def _get_exe_path_for_pid(pid: int) -> str | None:
    try:
        import psutil
        return psutil.Process(pid).exe()
    except Exception:
        return None


def _window_process(hwnd: int) -> Any:
    """Resolve the application process represented by a top-level HWND.

    Packaged/UWP apps are hosted by ApplicationFrameHost.exe: the visible
    top-level window belongs to the host while a CoreWindow child belongs to
    the real app (for example CalculatorApp.exe). Treating the host as the app
    makes an already visible packaged app look uninstalled and also breaks the
    foreground allowlist check.
    """
    import psutil
    import win32gui
    import win32process

    _, host_pid = win32process.GetWindowThreadProcessId(hwnd)
    host = psutil.Process(host_pid)
    if host.name().casefold() != "applicationframehost.exe":
        return host

    candidates: list[tuple[int, Any]] = []

    def _child_cb(child_hwnd: int, _: Any) -> None:
        try:
            _, child_pid = win32process.GetWindowThreadProcessId(child_hwnd)
            if int(child_pid) == int(host_pid):
                return
            child = psutil.Process(child_pid)
            child.exe()
            priority = 0 if win32gui.GetClassName(child_hwnd) == "Windows.UI.Core.CoreWindow" else 1
            candidates.append((priority, child))
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return

    win32gui.EnumChildWindows(hwnd, _child_cb, None)
    if not candidates:
        return host
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def _visible_gui_apps() -> list[dict[str, Any]]:
    """Return processes that own a visible, titled top-level window.

    The uninstall registry is not an application catalogue on modern Windows:
    inbox/MSIX apps such as Notepad and Calculator usually have no entry there.
    They still need to be requestable while they are running.  Enumerating
    windows, rather than every process, also keeps services, credential tools,
    terminals without a visible window, and other background processes out of
    the Computer Use application picker.
    """
    import psutil
    import win32gui

    results: dict[str, dict[str, Any]] = {}

    def _enum_cb(hwnd: int, _: Any) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        if not win32gui.GetWindowText(hwnd).strip():
            return
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            if right - left <= 1 or bottom - top <= 1:
                return
            proc = _window_process(hwnd)
            exe_path = proc.exe()
            bundle_id = _windows_bundle_id(exe_path)
            if not bundle_id:
                return
            results.setdefault(bundle_id.casefold(), {
                "bundleId": bundle_id,
                "displayName": proc.name(),
                "path": exe_path,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return

    win32gui.EnumWindows(_enum_cb, None)
    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def installed_apps() -> list[dict[str, Any]]:
    """List uninstall-registry apps plus currently visible GUI applications."""
    import winreg

    results: dict[str, dict[str, Any]] = {}
    reg_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]

    for hive, sub_key in reg_paths:
        try:
            key = winreg.OpenKey(hive, sub_key)
        except OSError:
            continue
        try:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    app_key = winreg.OpenKey(key, name)
                except OSError:
                    continue
                try:
                    display_name = winreg.QueryValueEx(app_key, "DisplayName")[0]
                except OSError:
                    winreg.CloseKey(app_key)
                    continue
                # Use the registry key name as a stable identifier (like bundleId)
                try:
                    install_location = winreg.QueryValueEx(app_key, "InstallLocation")[0]
                except OSError:
                    install_location = ""
                try:
                    display_icon = winreg.QueryValueEx(app_key, "DisplayIcon")[0]
                except OSError:
                    display_icon = ""
                normalized_icon = str(display_icon).split(",")[0].strip().strip('"')
                normalized_install_location = str(install_location).strip().strip('"')

                bundle_id = name
                for candidate in (normalized_icon, normalized_install_location):
                    if not candidate:
                        continue
                    candidate_path = Path(candidate)
                    if candidate_path.suffix.lower() == ".exe":
                        bundle_id = candidate_path.stem
                        break

                app_path = normalized_icon or normalized_install_location or ""
                if bundle_id not in results:
                    results[bundle_id] = {
                        "bundleId": bundle_id,
                        "displayName": str(display_name),
                        "path": app_path,
                    }
                winreg.CloseKey(app_key)
        finally:
            winreg.CloseKey(key)

    existing_ids = {bundle_id.casefold() for bundle_id in results}
    for app in _visible_gui_apps():
        if app["bundleId"].casefold() in existing_ids:
            continue
        results[app["bundleId"]] = app
        existing_ids.add(app["bundleId"].casefold())

    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def running_apps() -> list[dict[str, Any]]:
    """List running GUI applications."""
    return [
        {"bundleId": app["bundleId"], "displayName": app["displayName"]}
        for app in _visible_gui_apps()
    ]


def app_display_name(bundle_id: str) -> str | None:
    """Find display name for a given bundleId (exe stem or registry key)."""
    import psutil
    for proc in psutil.process_iter(["name", "exe"]):
        try:
            exe = proc.info["exe"] or ""
            if exe and Path(exe).stem == bundle_id:
                return proc.info["name"]
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return None


def _windows_bundle_id(exe_path: str) -> str:
    """Stable identity for the packaged Electron host; stem for other apps."""
    stem = Path(exe_path).stem
    if stem.casefold() == "claude code haha":
        return DESKTOP_HOST_BUNDLE_ID
    return stem


def _foreground_existing_app(bundle_id: str) -> bool:
    """Bring the frontmost matching visible window forward if one exists."""
    import psutil
    import win32con
    import win32gui

    wanted = bundle_id.casefold()
    matches: list[int] = []

    def _enum_cb(hwnd: int, _: Any) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        if not win32gui.GetWindowText(hwnd).strip():
            return
        try:
            proc = _window_process(hwnd)
            exe_path = proc.exe()
            candidates = {
                _windows_bundle_id(exe_path).casefold(),
                Path(exe_path).stem.casefold(),
                proc.name().casefold(),
            }
            if wanted in candidates:
                matches.append(hwnd)
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            return

    win32gui.EnumWindows(_enum_cb, None)
    if not matches:
        return False

    hwnd = matches[0]
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.SetForegroundWindow(hwnd)
    return True


def frontmost_app() -> dict[str, str] | None:
    """Get the currently focused (foreground) application."""
    import win32gui

    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None
    try:
        proc = _window_process(hwnd)
        exe_path = proc.exe()
        return {
            "bundleId": _windows_bundle_id(exe_path),
            "displayName": proc.name(),
        }
    except Exception:
        return None


def app_under_point(x: int, y: int) -> dict[str, str] | None:
    """Find the app whose window is under the given screen coordinate."""
    import win32gui

    hwnd = win32gui.WindowFromPoint((x, y))
    if not hwnd:
        return frontmost_app()
    # Walk up to the top-level owner
    root = win32gui.GetAncestor(hwnd, 3)  # GA_ROOTOWNER = 3
    if root:
        hwnd = root
    try:
        proc = _window_process(hwnd)
        exe_path = proc.exe()
        return {
            "bundleId": _windows_bundle_id(exe_path),
            "displayName": proc.name(),
        }
    except Exception:
        return frontmost_app()


def find_window_displays(bundle_ids: list[str]) -> list[dict[str, Any]]:
    """For each bundleId, find which display(s) its windows are on."""
    if not bundle_ids:
        return []

    displays = get_displays()
    windows = list_windows()

    # Build exe-stem -> ownerName mapping
    names_by_bundle: dict[str, str | None] = {}
    for bid in bundle_ids:
        names_by_bundle[bid] = app_display_name(bid)

    result = []
    for bundle_id in bundle_ids:
        target_name = names_by_bundle.get(bundle_id)
        display_ids: set[int] = set()
        for window in windows:
            owner = window["ownerName"]
            if not owner:
                continue
            # Match by exe name
            owner_stem = Path(owner).stem if owner.endswith(".exe") else owner
            if target_name and owner != target_name and owner_stem != bundle_id:
                continue
            if not target_name and owner_stem != bundle_id and owner != bundle_id:
                continue
            # Check which displays this window overlaps
            wx = window["bounds"]["x"]
            wy = window["bounds"]["y"]
            ww = window["bounds"]["width"]
            wh = window["bounds"]["height"]
            for display in displays:
                dx = display["originX"]
                dy = display["originY"]
                dw = display["width"]
                dh = display["height"]
                # Check rectangle intersection
                if wx < dx + dw and wx + ww > dx and wy < dy + dh and wy + wh > dy:
                    display_ids.add(int(display["displayId"]))
        result.append({"bundleId": bundle_id, "displayIds": sorted(display_ids)})
    return result


def open_app(bundle_id: str) -> None:
    """Open an application by its bundleId (exe path or program name)."""
    if _foreground_existing_app(bundle_id):
        return

    # Try to find the exe path from registry
    import winreg
    exe_path = None

    reg_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    for hive, sub_key in reg_paths:
        try:
            key = winreg.OpenKey(hive, sub_key)
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(key, i)
                    i += 1
                except OSError:
                    break
                try:
                    app_key = winreg.OpenKey(key, name)
                except OSError:
                    continue
                try:
                    display_icon = winreg.QueryValueEx(app_key, "DisplayIcon")[0]
                except OSError:
                    display_icon = ""
                try:
                    install_location = winreg.QueryValueEx(app_key, "InstallLocation")[0]
                except OSError:
                    install_location = ""

                normalized_icon = str(display_icon).split(",")[0].strip().strip('"')
                normalized_install_location = str(install_location).strip().strip('"')

                derived_bundle_id = name
                for candidate in (normalized_icon, normalized_install_location):
                    if not candidate:
                        continue
                    candidate_path = Path(candidate)
                    if candidate_path.suffix.lower() == ".exe":
                        derived_bundle_id = candidate_path.stem
                        break

                if name == bundle_id or derived_bundle_id == bundle_id:
                    exe_path = normalized_icon or normalized_install_location or None
                    winreg.CloseKey(app_key)
                    break
                winreg.CloseKey(app_key)
            winreg.CloseKey(key)
            if exe_path:
                break
        except OSError:
            continue

    if exe_path and Path(exe_path).exists():
        os.startfile(exe_path)
    else:
        # Fallback: try to run it directly
        try:
            subprocess.Popen([bundle_id], shell=True)
        except Exception:
            raise RuntimeError(f"App not found for identifier: {bundle_id}")


# ---------------------------------------------------------------------------
# Clipboard (pyperclip — cross-platform)
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
    _send_inputs([
        _named_key_input("ctrl"),
        _named_key_input("v"),
        _named_key_input("v", key_up=True),
        _named_key_input("ctrl", key_up=True),
    ])


# ---------------------------------------------------------------------------
# Physical input interference detection
# ---------------------------------------------------------------------------
#
# Why this exists at all, and why it is stricter than the macOS version.
#
# On macOS the helper posts events straight into the target process with
# `CGEvent.postToPid`, so agent input and human input never share a channel:
# the epoch monitor there is a safety net for an unlikely race.
#
# Windows has no such API. `pyautogui` uses `SetCursorPos`, `mouse_event`, and
# `keybd_event`, all of which feed the ONE system-wide input stream.
# The agent and the user are therefore holding the same mouse. If the user
# reaches for it mid-action the two streams interleave, and the resulting
# click lands somewhere neither of them intended. Detection is not a nicety
# here — it is the only thing standing between "the agent typed into the wrong
# window" and an abort.
#
# Neither GetLastInputInfo nor Raw Input identifies event origin: both advance
# for synthetic input on real Windows machines. Low-level keyboard and mouse
# hooks do. Windows sets LLKHF_INJECTED / LLMHF_INJECTED on synthetic events,
# so the monitor below can count physical input without tripping on its own
# actions. The hook callback does constant-time bookkeeping only; all policy
# decisions stay on the command thread.

WH_KEYBOARD_LL = 13
WH_MOUSE_LL = 14
HC_ACTION = 0
WM_QUIT = 0x0012
WM_APP_INPUT_BARRIER = 0x8001
PM_NOREMOVE = 0x0000
LLKHF_LOWER_IL_INJECTED = 0x02
LLKHF_INJECTED = 0x10
LLMHF_INJECTED = 0x01
LLMHF_LOWER_IL_INJECTED = 0x02
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_MOVE_NOCOALESCE = 0x2000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_ABSOLUTE = 0x8000
WHEEL_DELTA = 120
SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

# Mouse low-level hooks preserve only the low 32 bits of dwExtraInfo on some
# 64-bit Windows builds, while keyboard hooks preserve the full ULONG_PTR.
# A random non-zero 32-bit tag therefore compares identically in both paths.
# The TypeScript parent shares one tag with the virtual-cursor process so that
# it follows our SendInput stream, not injected input from unrelated software.
try:
    _INPUT_TAG = int(os.environ["CC_HAHA_COMPUTER_USE_INPUT_TAG"]) & 0xFFFFFFFF
except (KeyError, TypeError, ValueError):
    _INPUT_TAG = int.from_bytes(os.urandom(4), "little") or 0x43434841

_LRESULT = ctypes.c_ssize_t
_HOOKPROC = ctypes.WINFUNCTYPE(
    _LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
)


class _KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", wintypes.POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [
        ("mi", _MOUSEINPUT),
        ("ki", _KEYBDINPUT),
        ("hi", _HARDWAREINPUT),
    ]


class _INPUT(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [("type", wintypes.DWORD), ("data", _INPUTUNION)]


_user32 = ctypes.WinDLL("user32", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

_user32.SetWindowsHookExW.argtypes = [
    ctypes.c_int, _HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD,
]
_user32.SetWindowsHookExW.restype = wintypes.HANDLE
_user32.CallNextHookEx.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM,
]
_user32.CallNextHookEx.restype = _LRESULT
_user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
_user32.UnhookWindowsHookEx.restype = wintypes.BOOL
_user32.GetMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
]
_user32.GetMessageW.restype = ctypes.c_int
_user32.PeekMessageW.argtypes = [
    ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
    wintypes.UINT,
]
_user32.PeekMessageW.restype = wintypes.BOOL
_user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
_user32.TranslateMessage.restype = wintypes.BOOL
_user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
_user32.DispatchMessageW.restype = _LRESULT
_user32.PostThreadMessageW.argtypes = [
    wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
]
_user32.PostThreadMessageW.restype = wintypes.BOOL
_user32.SendInput.argtypes = [
    wintypes.UINT, ctypes.POINTER(_INPUT), ctypes.c_int,
]
_user32.SendInput.restype = wintypes.UINT
_user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
_user32.GetCursorPos.restype = wintypes.BOOL
_user32.GetSystemMetrics.argtypes = [ctypes.c_int]
_user32.GetSystemMetrics.restype = ctypes.c_int
_user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
_user32.MapVirtualKeyW.restype = wintypes.UINT
_user32.VkKeyScanW.argtypes = [wintypes.WCHAR]
_user32.VkKeyScanW.restype = ctypes.c_short
_user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
_user32.GetAsyncKeyState.restype = ctypes.c_short
_kernel32.GetCurrentThreadId.argtypes = []
_kernel32.GetCurrentThreadId.restype = wintypes.DWORD


class InputMonitorUnavailable(RuntimeError):
    """Physical-input monitoring could not be made reliable."""

    code = "input_monitor_unavailable"


class InputInjectionFailed(RuntimeError):
    """Windows did not accept the complete tagged SendInput batch."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class PhysicalInputMonitor:
    """Count every input event except this helper's tagged SendInput."""

    def __init__(self) -> None:
        self.interference_count = 0
        self.agent_count = 0
        self.expected_agent_count = 0
        self._thread_id = 0
        self._keyboard_hook: int | None = None
        self._mouse_hook: int | None = None
        self._ready = threading.Event()
        self._barrier = threading.Event()
        self._error: BaseException | None = None
        self._thread: threading.Thread | None = None
        # ctypes callbacks must be strongly referenced for the lifetime of the
        # native hooks; otherwise a GC cycle can leave Windows calling freed
        # Python memory.
        self._keyboard_callback = _HOOKPROC(self._keyboard_proc)
        self._mouse_callback = _HOOKPROC(self._mouse_proc)

    def _record(
        self, flags: int, injected_mask: int, extra_info: int
    ) -> None:
        if flags & injected_mask and extra_info == _INPUT_TAG:
            self.agent_count += 1
        else:
            self.interference_count += 1

    def _keyboard_proc(
        self, code: int, wparam: int, lparam: int
    ) -> int:
        try:
            if code == HC_ACTION:
                data = ctypes.cast(
                    lparam, ctypes.POINTER(_KBDLLHOOKSTRUCT)
                ).contents
                self._record(
                    int(data.flags),
                    LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED,
                    int(data.dwExtraInfo),
                )
        except BaseException as exc:
            self._error = exc
        finally:
            return int(_user32.CallNextHookEx(None, code, wparam, lparam))

    def _mouse_proc(self, code: int, wparam: int, lparam: int) -> int:
        try:
            if code == HC_ACTION:
                data = ctypes.cast(
                    lparam, ctypes.POINTER(_MSLLHOOKSTRUCT)
                ).contents
                self._record(
                    int(data.flags),
                    LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED,
                    int(data.dwExtraInfo),
                )
        except BaseException as exc:
            self._error = exc
        finally:
            return int(_user32.CallNextHookEx(None, code, wparam, lparam))

    def _run(self) -> None:
        self._thread_id = int(_kernel32.GetCurrentThreadId())
        try:
            # PostThreadMessage fails until the destination thread owns a
            # message queue. PeekMessage creates it before start() can return.
            queue_message = wintypes.MSG()
            _user32.PeekMessageW(
                ctypes.byref(queue_message), None, 0, 0, PM_NOREMOVE
            )
            self._keyboard_hook = _user32.SetWindowsHookExW(
                WH_KEYBOARD_LL, self._keyboard_callback, None, 0
            )
            if not self._keyboard_hook:
                raise ctypes.WinError(ctypes.get_last_error())
            self._mouse_hook = _user32.SetWindowsHookExW(
                WH_MOUSE_LL, self._mouse_callback, None, 0
            )
            if not self._mouse_hook:
                raise ctypes.WinError(ctypes.get_last_error())
            self._ready.set()

            message = wintypes.MSG()
            while True:
                status = _user32.GetMessageW(
                    ctypes.byref(message), None, 0, 0
                )
                if status == -1:
                    raise ctypes.WinError(ctypes.get_last_error())
                if status == 0:
                    break
                if message.message == WM_APP_INPUT_BARRIER:
                    self._barrier.set()
                    continue
                _user32.TranslateMessage(ctypes.byref(message))
                _user32.DispatchMessageW(ctypes.byref(message))
        except BaseException as exc:
            self._error = exc
            self._ready.set()
            self._barrier.set()
        finally:
            if self._mouse_hook:
                if not _user32.UnhookWindowsHookEx(self._mouse_hook):
                    self._error = self._error or ctypes.WinError(
                        ctypes.get_last_error()
                    )
                self._mouse_hook = None
            if self._keyboard_hook:
                if not _user32.UnhookWindowsHookEx(self._keyboard_hook):
                    self._error = self._error or ctypes.WinError(
                        ctypes.get_last_error()
                    )
                self._keyboard_hook = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name="computer-use-input-monitor", daemon=True
        )
        self._thread.start()
        if not self._ready.wait(timeout=2.0) or self._error is not None:
            self.stop()
            detail = f": {self._error}" if self._error is not None else ""
            raise InputMonitorUnavailable(
                "Windows could not start physical-input monitoring, so the "
                f"action was not sent{detail}"
            )

    def snapshot(self) -> int:
        """Drain earlier hook callbacks and return the physical input count."""
        if self._error is not None or not self._thread_id:
            raise InputMonitorUnavailable(
                "Windows physical-input monitoring stopped unexpectedly; "
                "the action result cannot be trusted"
            )
        self._barrier.clear()
        if not _user32.PostThreadMessageW(
            self._thread_id, WM_APP_INPUT_BARRIER, 0, 0
        ):
            raise InputMonitorUnavailable(
                "Windows could not synchronize physical-input monitoring; "
                "the action result cannot be trusted"
            )
        if not self._barrier.wait(timeout=2.0) or self._error is not None:
            raise InputMonitorUnavailable(
                "Windows physical-input monitoring did not respond; the "
                "action result cannot be trusted"
            )
        if self.agent_count < self.expected_agent_count:
            raise InputMonitorUnavailable(
                "Windows stopped reporting this helper's tagged input; the "
                "action result cannot be trusted"
            )
        return self.interference_count

    def expect_agent_events(self, count: int) -> None:
        self.expected_agent_count += count

    def stop(self) -> None:
        thread = self._thread
        if thread is None:
            return
        if thread.is_alive():
            if not self._thread_id or not _user32.PostThreadMessageW(
                self._thread_id, WM_QUIT, 0, 0
            ):
                raise InputMonitorUnavailable(
                    "Windows could not stop physical-input monitoring"
                )
            thread.join(timeout=2.0)
            if thread.is_alive():
                raise InputMonitorUnavailable(
                    "Windows physical-input monitoring did not stop"
                )
        self._thread = None
        if self._error is not None:
            raise InputMonitorUnavailable(
                f"Windows physical-input monitoring failed: {self._error}"
            )


_active_input_monitor: PhysicalInputMonitor | None = None


def _mouse_input(
    flags: int, *, data: int = 0, dx: int = 0, dy: int = 0
) -> _INPUT:
    event = _INPUT()
    event.type = INPUT_MOUSE
    event.mi = _MOUSEINPUT(
        dx,
        dy,
        ctypes.c_ulong(data).value,
        flags,
        0,
        _INPUT_TAG,
    )
    return event


def _key_input(vk: int, scan: int, flags: int) -> _INPUT:
    event = _INPUT()
    event.type = INPUT_KEYBOARD
    event.ki = _KEYBDINPUT(vk, scan, flags, 0, _INPUT_TAG)
    return event


def _send_inputs(events: list[_INPUT]) -> None:
    """Insert one atomic, tagged input batch and account for every event."""
    if not events:
        return
    event_array = (_INPUT * len(events))(*events)
    sent = int(_user32.SendInput(
        len(events), event_array, ctypes.sizeof(_INPUT)
    ))
    if _active_input_monitor is not None and sent:
        _active_input_monitor.expect_agent_events(sent)
    if sent != len(events):
        if sent:
            raise InputInjectionFailed(
                f"Windows accepted only {sent} of {len(events)} input events. "
                "The result is UNKNOWN; inspect the screen before continuing.",
                code="input_injection_result_unknown",
            )
        raise InputInjectionFailed(
            "Windows refused the input batch. The target may be elevated or "
            "on a secure desktop; nothing was reported as inserted.",
            code="input_injection_failed",
        )


def _absolute_mouse_move(x: int, y: int) -> _INPUT:
    left = _user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = _user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = _user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    height = _user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    if width <= 1 or height <= 1:
        raise InputInjectionFailed(
            "Windows did not report a usable virtual desktop.",
            code="input_injection_failed",
        )
    dx = round((x - left) * 65535 / (width - 1))
    dy = round((y - top) * 65535 / (height - 1))
    return _mouse_input(
        MOUSEEVENTF_MOVE
        | MOUSEEVENTF_MOVE_NOCOALESCE
        | MOUSEEVENTF_VIRTUALDESK
        | MOUSEEVENTF_ABSOLUTE,
        dx=dx,
        dy=dy,
    )


def _spring_cursor_path(
    start_x: int,
    start_y: int,
    target_x: int,
    target_y: int,
) -> list[tuple[int, int]]:
    """Sample the same damped-spring motion used by the macOS cursor."""
    distance = ((target_x - start_x) ** 2 + (target_y - start_y) ** 2) ** 0.5
    if distance < 2:
        return [(target_x, target_y)]

    # CursorMotionState.swift uses k=196 and a damping ratio of 0.85. A
    # 60-Hz fixed step gives Windows the same zero-velocity start and gentle
    # settle while keeping physical-pointer actions bounded.
    frame_interval = 1.0 / 60.0
    stiffness = 196.0
    damping = 2.0 * 0.85 * stiffness ** 0.5
    max_duration = min(0.45, max(0.20, distance / 3000.0))
    sample_count = max(1, round(max_duration / frame_interval))

    pos_x, pos_y = float(start_x), float(start_y)
    vel_x = vel_y = 0.0
    points: list[tuple[int, int]] = []
    for _ in range(sample_count):
        vel_x += (stiffness * (target_x - pos_x) - damping * vel_x) * frame_interval
        vel_y += (stiffness * (target_y - pos_y) - damping * vel_y) * frame_interval
        pos_x += vel_x * frame_interval
        pos_y += vel_y * frame_interval
        point = (round(pos_x), round(pos_y))
        if not points or point != points[-1]:
            points.append(point)

        remaining = ((target_x - pos_x) ** 2 + (target_y - pos_y) ** 2) ** 0.5
        speed = (vel_x ** 2 + vel_y ** 2) ** 0.5
        if remaining < 0.5 and speed < 6.0:
            break

    target = (target_x, target_y)
    if not points or points[-1] != target:
        points.append(target)
    return points


def _move_cursor_to(x: int, y: int, animate: bool) -> None:
    """Move the shared pointer with the macOS virtual-cursor spring."""
    current = wintypes.POINT()
    if not _user32.GetCursorPos(ctypes.byref(current)):
        _send_inputs([_absolute_mouse_move(x, y)])
        return

    start_x, start_y = int(current.x), int(current.y)
    if not animate:
        _send_inputs([_absolute_mouse_move(x, y)])
        return

    points = _spring_cursor_path(start_x, start_y, x, y)
    started = time.perf_counter()
    for index, (next_x, next_y) in enumerate(points):
        _send_inputs([_absolute_mouse_move(next_x, next_y)])
        if index < len(points) - 1:
            deadline = started + (index + 1) / 60.0
            delay = deadline - time.perf_counter()
            if delay > 0:
                time.sleep(delay)


_VIRTUAL_KEYS = {
    "win": 0x5B,
    "ctrl": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "esc": 0x1B,
    "enter": 0x0D,
    "tab": 0x09,
    "space": 0x20,
    "backspace": 0x08,
    "delete": 0x2E,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "capslock": 0x14,
    **{f"f{number}": 0x6F + number for number in range(1, 13)},
}

_HELD_INPUT_KEYS = {
    0x01: "left mouse button",
    0x02: "right mouse button",
    0x04: "middle mouse button",
    0x10: "Shift",
    0x11: "Control",
    0x12: "Alt",
    0x5B: "left Windows key",
    0x5C: "right Windows key",
}


def _virtual_key(name: str) -> int:
    if name == "fn":
        raise ValueError("The Fn key cannot be synthesized by Windows")
    if name in _VIRTUAL_KEYS:
        return _VIRTUAL_KEYS[name]
    if len(name) != 1:
        raise ValueError(f"Unsupported key: {name}")
    mapped = int(_user32.VkKeyScanW(name))
    if mapped == -1:
        raise ValueError(f"The active keyboard layout cannot type key: {name}")
    return mapped & 0xFF


def _named_key_input(name: str, *, key_up: bool = False) -> _INPUT:
    vk = _virtual_key(name)
    scan = int(_user32.MapVirtualKeyW(vk, 0))
    return _key_input(vk, scan, KEYEVENTF_KEYUP if key_up else 0)


def _unicode_inputs(text: str) -> list[_INPUT]:
    encoded = text.encode("utf-16-le")
    events: list[_INPUT] = []
    for index in range(0, len(encoded), 2):
        code_unit = int.from_bytes(encoded[index:index + 2], "little")
        events.append(_key_input(0, code_unit, KEYEVENTF_UNICODE))
        events.append(
            _key_input(0, code_unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        )
    return events


def _held_inputs(command: str) -> list[str]:
    held: list[str] = []
    for vk, name in _HELD_INPUT_KEYS.items():
        if command == "mouse_up" and vk == 0x01:
            continue
        if int(_user32.GetAsyncKeyState(vk)) & 0x8000:
            held.append(name)
    return held


class UserInterference(RuntimeError):
    """The user touched the physical mouse or keyboard during an action."""

    def __init__(self, message: str, code: str = "user_interference") -> None:
        super().__init__(message)
        self.code = code


def _foreground_window_pid() -> int | None:
    try:
        import win32gui
        import win32process
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return int(pid)
    except Exception:
        return None


class ForegroundLease:
    """Guards one mutating action against concurrent physical input.

    A low-level hook runs for the lease lifetime. Barrier snapshots drain hook
    callbacks before policy is evaluated, so the command thread never mistakes
    its own injected input for a human event.

    The asymmetry between the two failure modes is deliberate and is the whole
    point of the class:

      * interference BEFORE the action  -> `user_interference`. Nothing ran.
        The caller may safely retry.
      * interference DURING the action  -> `user_interference_result_unknown`.
        Injection already went into the shared input stream and we cannot know
        how much of it landed, or where. Retrying could double-apply it. The
        error says so rather than guessing.
    """

    def __init__(self, command: str) -> None:
        self.command = command
        self.monitor = PhysicalInputMonitor()
        self.epoch = 0
        self.pid: int | None = None
        self._closed = False
        self._action_started = False

    def acquire(self) -> None:
        global _active_input_monitor
        self.monitor.start()
        _active_input_monitor = self.monitor
        before = self.monitor.snapshot()
        held = _held_inputs(self.command)
        self.pid = _foreground_window_pid()
        after = self.monitor.snapshot()
        if before != after or held:
            self.close()
            detail = f" Held input: {', '.join(held)}." if held else ""
            raise UserInterference(
                "The user was typing or moving the mouse, so the action was "
                "not sent. Nothing has changed; it is safe to try again."
                + detail
            )
        self.epoch = after

    def mark_started(self) -> None:
        self._action_started = True

    def finalize(self) -> None:
        try:
            before = self.monitor.snapshot()
            pid = _foreground_window_pid()
            after = self.monitor.snapshot()
        except InputMonitorUnavailable as exc:
            raise UserInterference(
                f"{exc}. Input was already sent, so the result is UNKNOWN; "
                "take a screenshot before continuing.",
                code="user_interference_result_unknown",
            ) from exc

        if before != after:
            raise UserInterference(
                "The user used the mouse or keyboard while this action was "
                "running. Because Windows shares one input stream between you "
                "and the user, the two may have interleaved and the result is "
                "UNKNOWN. Do not repeat the action — take a screenshot and "
                "read the current state before deciding anything.",
                code="user_interference_result_unknown",
            )

        if self.epoch != after:
            raise UserInterference(
                "The user used the mouse or keyboard while this action was "
                "running. The result is UNKNOWN — do not repeat the action; "
                "take a screenshot and read the current state first.",
                code="user_interference_result_unknown",
            )

        # A foreground change without any physical input is the target app (or
        # a background app) stealing activation, not the user. Worth reporting,
        # because everything typed after it went somewhere unintended.
        if (
            self.command in {"type", "paste_clipboard"}
            and self.pid is not None
            and pid is not None
            and self.pid != pid
        ):
            raise UserInterference(
                "The foreground application changed while this action was "
                "running, so input may have gone to the wrong window. The "
                "result is UNKNOWN — take a screenshot before continuing.",
                code="user_interference_result_unknown",
            )

    def close(self) -> None:
        global _active_input_monitor
        if self._closed:
            return
        try:
            self.monitor.stop()
        except InputMonitorUnavailable as exc:
            if self._action_started:
                raise UserInterference(
                    f"{exc}. Input was already sent, so the result is "
                    "UNKNOWN; take a screenshot before continuing.",
                    code="user_interference_result_unknown",
                ) from exc
            raise
        finally:
            if _active_input_monitor is self.monitor:
                _active_input_monitor = None
            self._closed = True


# ---------------------------------------------------------------------------
# Permissions — Windows doesn't have macOS-style TCC
# ---------------------------------------------------------------------------

def check_permissions() -> dict[str, bool | None]:
    """Windows does not require explicit accessibility/screen-recording
    permissions like macOS TCC. Always report as granted."""
    return {
        "accessibility": True,
        "screenRecording": True,
    }


# ---------------------------------------------------------------------------
# Delivery preconditions — refuse rather than report a lie
# ---------------------------------------------------------------------------
#
# `SendInput` always "succeeds": it returns the number of events inserted into
# the input stream, never whether anything acted on them. Click a point behind
# another window and the click lands on THAT window; click a point off-screen
# and it lands nowhere. Either way pyautogui returns cleanly and the helper
# would answer "Action completed".
#
# That specific lie has burned us before on macOS — a session typed into a
# minimized window for a full turn because every action reported success. The
# fix there was to refuse instead of guessing, and the same rule applies here.

class DeliveryRefused(RuntimeError):
    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


def _virtual_screen_rect() -> tuple[int, int, int, int] | None:
    """(left, top, right, bottom) across all monitors, or None if unavailable."""
    try:
        user32 = ctypes.windll.user32
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79
        left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
        width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
        height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
        if width <= 0 or height <= 0:
            return None
        return (left, top, left + width, top + height)
    except Exception:
        return None


def ensure_point_on_screen(x: int, y: int) -> None:
    """Refuse coordinates outside every monitor.

    Fails OPEN when the metrics are unreadable: an unreadable metric is our
    problem, not the caller's, and blocking every action on it would be worse
    than the miss it prevents.
    """
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


def _window_is_interactable(hwnd: int) -> tuple[bool, str]:
    """(ok, reason) — whether synthetic input can reach this window at all."""
    try:
        import win32gui
        if not win32gui.IsWindow(hwnd):
            return False, "the window no longer exists"
        if not win32gui.IsWindowVisible(hwnd):
            return False, "the window is hidden"
        try:
            import win32con
            placement = win32gui.GetWindowPlacement(hwnd)
            if placement and placement[1] == win32con.SW_SHOWMINIMIZED:
                return False, "the window is minimized"
        except Exception:
            pass
        rect = win32gui.GetWindowRect(hwnd)
        if rect[2] - rect[0] <= 0 or rect[3] - rect[1] <= 0:
            return False, "the window has no on-screen area"
        return True, ""
    except Exception:
        # Unreadable window state fails open, same reasoning as above.
        return True, ""


def _windows_for_bundle(bundle_id: str) -> list[int]:
    """Every top-level HWND owned by a process whose exe stem matches.

    Enumerates directly rather than reusing `list_windows()`, which filters out
    invisible and zero-area windows — precisely the states this guard needs to
    SEE in order to refuse. Reusing it would make the guard match nothing and
    silently pass, which is the failure mode it was written to prevent.
    """
    try:
        import win32gui
        import psutil
    except Exception:
        return []

    wanted = bundle_id.strip().lower()
    if not wanted:
        return []

    pids: set[int] = set()
    try:
        for proc in psutil.process_iter(["pid", "name", "exe"]):
            try:
                exe_path = proc.info.get("exe") or ""
                name = proc.info.get("name") or ""
                stem = Path(exe_path).stem if exe_path else Path(name).stem
                if stem and stem.lower() == wanted:
                    pids.add(int(proc.info["pid"]))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        return []

    if not pids:
        return []

    handles: list[int] = []

    def _collect(hwnd: int, _: Any) -> None:
        try:
            proc = _window_process(hwnd)
            if int(proc.pid) in pids:
                handles.append(int(hwnd))
        except Exception:
            return

    try:
        win32gui.EnumWindows(_collect, None)
    except Exception:
        return []
    return handles


def ensure_target_window_reachable(bundle_id: str | None) -> None:
    """Refuse when the named app has no window that input could reach.

    A minimized window is the case that matters: on Windows it has no client
    area to hit-test against, so a coordinate click is guaranteed to land on
    whatever is underneath it. Reporting success there is exactly the lie this
    guard exists to prevent.

    Fails OPEN when the app owns no top-level windows at all — that is a
    different failure (wrong app name, app not running) which the caller's own
    resolution step reports with a better message than this one could.
    """
    if not bundle_id:
        return

    handles = _windows_for_bundle(bundle_id)
    if not handles:
        return

    reasons: list[str] = []
    for hwnd in handles:
        ok, reason = _window_is_interactable(hwnd)
        if ok:
            return
        if reason:
            reasons.append(reason)

    detail = reasons[0] if reasons else "it has no on-screen window"
    raise DeliveryRefused(
        f"The target app has no window that input can reach — {detail}. "
        "The action was NOT sent. Restore the window and try again.",
        code="target_window_offscreen",
    )


# ---------------------------------------------------------------------------
# Input actions (tagged, atomic SendInput batches)
# ---------------------------------------------------------------------------

def click(
    x: int,
    y: int,
    button: str,
    count: int,
    modifiers: list[str] | None,
    animate: bool = True,
) -> None:
    buttons = {
        "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
    if button not in buttons:
        raise ValueError(f"Unsupported mouse button: {button}")
    normalized = [normalize_key(m) for m in (modifiers or [])]
    down_flag, up_flag = buttons[button]
    _move_cursor_to(x, y, animate)
    events = []
    events.extend(_named_key_input(key) for key in normalized)
    for _ in range(max(1, count)):
        events.append(_mouse_input(down_flag))
        events.append(_mouse_input(up_flag))
    events.extend(
        _named_key_input(key, key_up=True) for key in reversed(normalized)
    )
    _send_inputs(events)


def scroll(
    x: int,
    y: int,
    delta_x: int,
    delta_y: int,
    animate: bool = True,
) -> None:
    _move_cursor_to(x, y, animate)
    events = []
    if delta_y:
        events.append(_mouse_input(
            MOUSEEVENTF_WHEEL, data=int(delta_y) * WHEEL_DELTA
        ))
    if delta_x:
        events.append(_mouse_input(
            MOUSEEVENTF_HWHEEL, data=int(delta_x) * WHEEL_DELTA
        ))
    _send_inputs(events)


def key_action(sequence: str, repeat: int = 1) -> None:
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    for _ in range(max(1, repeat)):
        events = [_named_key_input(key) for key in parts]
        events.extend(
            _named_key_input(key, key_up=True) for key in reversed(parts)
        )
        _send_inputs(events)
        time.sleep(0.01)


def hold_keys(keys: list[str], duration_ms: int) -> None:
    normalized = [normalize_key(k) for k in keys]
    _send_inputs([_named_key_input(key) for key in normalized])
    try:
        time.sleep(max(duration_ms, 0) / 1000)
    finally:
        _send_inputs([
            _named_key_input(key, key_up=True)
            for key in reversed(normalized)
        ])


def type_text(text: str) -> None:
    # The TypeScript MCP sends the complete Windows type action in one helper
    # call. New Notepad's RichEdit control silently drops or reorders faster
    # Unicode bursts, so pace delivery here while retaining one process, one
    # foreground lease, and one interference monitor for the complete action.
    # Return and Tab remain real key presses rather than Unicode insertion.
    index = 0
    while index < len(text):
        character = text[index]
        time.sleep(0.025)
        if character in {"\r", "\n", "\t"}:
            if character == "\r" and index + 1 < len(text) and text[index + 1] == "\n":
                index += 1
            key = normalize_key("tab" if character == "\t" else "return")
            _send_inputs([
                _named_key_input(key),
                _named_key_input(key, key_up=True),
            ])
        else:
            _send_inputs(_unicode_inputs(character))
        index += 1


# ---------------------------------------------------------------------------
# Main dispatcher — the command protocol the native macOS daemon also speaks
# ---------------------------------------------------------------------------

# Commands that inject into the shared Windows input stream. Kept as one set
# rather than as a guard call inside each branch, because the branches are the
# easy place to forget one — and a forgotten branch is silently unguarded, the
# exact class of bug this whole pass exists to remove.
#
# Mirrors `CommandForegroundPolicy.leasedCommands` on the macOS side.
MUTATING_COMMANDS = frozenset({
    "click", "drag", "move_mouse", "scroll",
    "mouse_down", "mouse_up",
    "key", "hold_key", "type",
    "paste_clipboard",
})

# The subset that targets a screen coordinate, and so needs the point itself to
# be reachable. `key`/`type` go to whatever holds focus and have no coordinate
# to check.
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
    """Emit the success response for a mutating command, after the lease agrees.

    The check runs BEFORE the response is written, and that ordering is the
    whole point: once `{"ok": true}` reaches the caller the action is reported
    as done, and no later discovery can take that back. A helper that injected
    input, then noticed the user had been typing throughout, and still answered
    "Action completed" would be lying with a straight face.
    """
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
            perms = check_permissions()
            json_output({"ok": True, "result": perms})
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
            _send_inputs([_mouse_input(MOUSEEVENTF_LEFTDOWN)])
            _move_cursor_to(target_x, target_y, animate)
            _send_inputs([_mouse_input(MOUSEEVENTF_LEFTUP)])
            return _finish(lease, True)
        if command == "move_mouse":
            _move_cursor_to(
                int(payload["x"]), int(payload["y"]),
                bool(payload.get("animate", True)),
            )
            return _finish(lease, True)
        if command == "scroll":
            scroll(int(payload["x"]), int(payload["y"]), int(payload.get("deltaX") or 0), int(payload.get("deltaY") or 0), bool(payload.get("animate", True)))
            return _finish(lease, True)
        if command == "mouse_down":
            _send_inputs([_mouse_input(MOUSEEVENTF_LEFTDOWN)])
            return _finish(lease, True)
        if command == "mouse_up":
            _send_inputs([_mouse_input(MOUSEEVENTF_LEFTUP)])
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
        # A deliberate refusal, not a crash. The code travels so the caller can
        # tell "did not run, safe to retry" apart from "ran, outcome unknown" —
        # collapsing both into a generic error is how a model ends up repeating
        # a toggle it already flipped.
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
                # Successful mutations close inside _finish before emitting
                # JSON, so any cleanup failure there is already surfaced. If
                # dispatch raised, preserve that first machine-readable error
                # while still making a best-effort cleanup here.
                pass


if __name__ == "__main__":
    raise SystemExit(main())
