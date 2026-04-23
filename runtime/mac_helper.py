#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path
from typing import Any

import mss
from AppKit import NSWorkspace, NSPasteboard, NSPasteboardTypeString, NSURL
from PIL import Image
from Quartz import (
    CGDisplayBounds,
    CGDisplayIsMain,
    CGDisplayModeGetPixelHeight,
    CGDisplayModeGetPixelWidth,
    CGDisplayPixelsHigh,
    CGDisplayPixelsWide,
    CGGetActiveDisplayList,
    CGMainDisplayID,
    CGWindowListCopyWindowInfo,
    CGRectContainsPoint,
    CGRectIntersection,
    CGPointMake,
    CGPreflightScreenCaptureAccess,
    kCGNullWindowID,
    kCGWindowBounds,
    kCGWindowIsOnscreen,
    kCGWindowLayer,
    kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly,
    kCGWindowName,
    kCGWindowOwnerName,
)

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

import pyautogui  # noqa: E402

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

KEY_MAP = {
    "a": "a",
    "b": "b",
    "c": "c",
    "d": "d",
    "e": "e",
    "f": "f",
    "g": "g",
    "h": "h",
    "i": "i",
    "j": "j",
    "k": "k",
    "l": "l",
    "m": "m",
    "n": "n",
    "o": "o",
    "p": "p",
    "q": "q",
    "r": "r",
    "s": "s",
    "t": "t",
    "u": "u",
    "v": "v",
    "w": "w",
    "x": "x",
    "y": "y",
    "z": "z",
    "0": "0",
    "1": "1",
    "2": "2",
    "3": "3",
    "4": "4",
    "5": "5",
    "6": "6",
    "7": "7",
    "8": "8",
    "9": "9",
    "cmd": "command",
    "command": "command",
    "meta": "command",
    "super": "command",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "option",
    "option": "option",
    "opt": "option",
    "fn": "fn",
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
    "f1": "f1",
    "f2": "f2",
    "f3": "f3",
    "f4": "f4",
    "f5": "f5",
    "f6": "f6",
    "f7": "f7",
    "f8": "f8",
    "f9": "f9",
    "f10": "f10",
    "f11": "f11",
    "f12": "f12",
    "-": "minus",
    "=": "equals",
    "[": "[",
    "]": "]",
    "\\": "\\",
    ";": ";",
    "'": "'",
    ",": ",",
    ".": ".",
    "/": "/",
    "`": "`",
}


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if key not in KEY_MAP:
        raise ValueError(f"Unsupported key: {name}")
    return KEY_MAP[key]


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


def run_osascript(script: str) -> str:
    result = subprocess.run(
        ["osascript", "-e", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "osascript failed")
    return result.stdout.strip()


def applescript_modifier(name: str) -> str:
    if name == "command":
        return "command down"
    if name == "option":
        return "option down"
    if name == "shift":
        return "shift down"
    if name == "ctrl":
        return "control down"
    if name == "fn":
        return "fn down"
    raise ValueError(f"Unsupported AppleScript modifier: {name}")


def send_keystroke_via_osascript(character: str, modifiers: list[str] | None = None) -> None:
    escaped = character.replace("\\", "\\\\").replace('"', '\\"')
    if modifiers:
        modifier_expr = ", ".join(applescript_modifier(m) for m in modifiers)
        script = (
            'tell application "System Events" to keystroke '
            f'"{escaped}" using {{{modifier_expr}}}'
        )
    else:
        script = f'tell application "System Events" to keystroke "{escaped}"'
    run_osascript(script)


def get_displays() -> list[dict[str, Any]]:
    max_displays = 32
    err, active, count = CGGetActiveDisplayList(max_displays, None, None)
    if err != 0:
        raise RuntimeError(f"CGGetActiveDisplayList failed: {err}")
    displays: list[dict[str, Any]] = []
    main_id = CGMainDisplayID()
    for idx, display_id in enumerate(active[:count]):
        bounds = CGDisplayBounds(display_id)
        mode = None
        try:
            from Quartz import CGDisplayCopyDisplayMode
            mode = CGDisplayCopyDisplayMode(display_id)
        except Exception:
            mode = None
        physical_width = int(CGDisplayPixelsWide(display_id))
        physical_height = int(CGDisplayPixelsHigh(display_id))
        logical_width = int(bounds.size.width)
        logical_height = int(bounds.size.height)
        if mode is not None:
            mode_w = int(CGDisplayModeGetPixelWidth(mode))
            mode_h = int(CGDisplayModeGetPixelHeight(mode))
            physical_width = mode_w or physical_width
            physical_height = mode_h or physical_height
        scale_factor = physical_width / logical_width if logical_width else 1
        name = f"Display {idx + 1}"
        displays.append(
            {
                "id": int(display_id),
                "displayId": int(display_id),
                "width": logical_width,
                "height": logical_height,
                "scaleFactor": scale_factor,
                "originX": int(bounds.origin.x),
                "originY": int(bounds.origin.y),
                "isPrimary": bool(display_id == main_id or CGDisplayIsMain(display_id)),
                "name": name,
                "label": name,
            }
        )
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


def ensure_screen_recording_permission() -> None:
    """No-op: CGPreflightScreenCaptureAccess is unreliable for child processes
    (returns False even when the parent app has TCC permission), and any actual
    capture attempt triggers a macOS popup on newer versions. Let the actual
    capture call handle errors instead."""
    pass


def capture_display(display_id: int | None, resize: tuple[int, int] | None = None) -> dict[str, Any]:
    ensure_screen_recording_permission()
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
    ensure_screen_recording_permission()
    with mss.mss() as sct:
        raw = sct.grab(region)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"base64": base64_data, "width": image.width, "height": image.height}


def list_windows() -> list[dict[str, Any]]:
    windows = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )
    out: list[dict[str, Any]] = []
    for window in windows or []:
        if int(window.get(kCGWindowLayer, 0)) != 0:
            continue
        if not bool(window.get(kCGWindowIsOnscreen, True)):
            continue
        bounds = window.get(kCGWindowBounds) or {}
        width = int(bounds.get("Width", 0))
        height = int(bounds.get("Height", 0))
        if width <= 1 or height <= 1:
            continue
        out.append(
            {
                "ownerName": window.get(kCGWindowOwnerName, "") or "",
                "title": window.get(kCGWindowName, "") or "",
                "bounds": {
                    "x": int(bounds.get("X", 0)),
                    "y": int(bounds.get("Y", 0)),
                    "width": width,
                    "height": height,
                },
            }
        )
    return out


def bundle_id_to_app(bundle_id: str):
    return NSWorkspace.sharedWorkspace().URLForApplicationWithBundleIdentifier_(bundle_id)


def installed_apps() -> list[dict[str, Any]]:
    search_roots = [
        Path("/Applications"),
        Path.home() / "Applications",
        Path("/System/Applications"),
        Path("/System/Applications/Utilities"),
    ]
    results: dict[str, dict[str, Any]] = {}
    workspace = NSWorkspace.sharedWorkspace()
    for root in search_roots:
        if not root.exists():
            continue
        for app in root.rglob("*.app"):
            try:
                bundle = workspace.bundleIdentifierForURL_(NSURL.fileURLWithPath_(str(app)))
            except Exception:
                bundle = None
            if not bundle:
                try:
                    url = workspace.URLForApplicationWithBundleIdentifier_(str(app))
                    bundle = workspace.bundleIdentifierForURL_(url) if url else None
                except Exception:
                    bundle = None
            info_plist = app / "Contents/Info.plist"
            display_name = app.stem
            if info_plist.exists():
                try:
                    import plistlib
                    with info_plist.open("rb") as f:
                        plist = plistlib.load(f)
                    bundle = bundle or plist.get("CFBundleIdentifier")
                    display_name = plist.get("CFBundleDisplayName") or plist.get("CFBundleName") or display_name
                except Exception:
                    pass
            if not bundle or bundle in results:
                continue
            results[bundle] = {
                "bundleId": str(bundle),
                "displayName": str(display_name),
                "path": str(app),
            }
    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def running_apps() -> list[dict[str, Any]]:
    apps = []
    seen = set()
    for app in NSWorkspace.sharedWorkspace().runningApplications() or []:
        bundle_id = app.bundleIdentifier()
        if not bundle_id or bundle_id in seen:
            continue
        seen.add(bundle_id)
        name = app.localizedName() or bundle_id
        apps.append({"bundleId": str(bundle_id), "displayName": str(name)})
    return sorted(apps, key=lambda item: item["displayName"].lower())


def app_display_name(bundle_id: str) -> str | None:
    for app in NSWorkspace.sharedWorkspace().runningApplications() or []:
        if app.bundleIdentifier() == bundle_id:
            return str(app.localizedName() or bundle_id)
    for app in installed_apps():
        if app["bundleId"] == bundle_id:
            return str(app["displayName"])
    return None


def frontmost_app() -> dict[str, str] | None:
    app = NSWorkspace.sharedWorkspace().frontmostApplication()
    if not app:
        return None
    bundle_id = app.bundleIdentifier()
    if not bundle_id:
        return None
    return {
        "bundleId": str(bundle_id),
        "displayName": str(app.localizedName() or bundle_id),
    }


def app_under_point(x: int, y: int) -> dict[str, str] | None:
    point = CGPointMake(x, y)
    running_by_name = {
        str(app.localizedName() or app.bundleIdentifier()): str(app.bundleIdentifier())
        for app in NSWorkspace.sharedWorkspace().runningApplications() or []
        if app.bundleIdentifier()
    }
    for window in list_windows():
        bounds = window["bounds"]
        rect = ((bounds["x"], bounds["y"]), (bounds["width"], bounds["height"]))
        if CGRectContainsPoint(rect, point):
            owner = window["ownerName"]
            bundle = running_by_name.get(owner)
            if bundle:
                return {"bundleId": bundle, "displayName": str(owner)}
    return frontmost_app()


def find_window_displays(bundle_ids: list[str]) -> list[dict[str, Any]]:
    if not bundle_ids:
        return []
    displays = get_displays()
    names_by_bundle = {
        bundle_id: app_display_name(bundle_id) or bundle_id for bundle_id in bundle_ids
    }
    windows = list_windows()
    result = []
    for bundle_id in bundle_ids:
        target_name = names_by_bundle.get(bundle_id)
        display_ids: set[int] = set()
        for window in windows:
            owner = window["ownerName"]
            if not owner:
                continue
            if target_name and owner != target_name:
                continue
            if not target_name and owner != bundle_id:
                continue
            wx = window["bounds"]["x"]
            wy = window["bounds"]["y"]
            ww = window["bounds"]["width"]
            wh = window["bounds"]["height"]
            window_rect = ((wx, wy), (ww, wh))
            for display in displays:
                display_rect = ((display["originX"], display["originY"]), (display["width"], display["height"]))
                intersection = CGRectIntersection(window_rect, display_rect)
                if intersection.size.width > 0 and intersection.size.height > 0:
                    display_ids.add(int(display["displayId"]))
        result.append({"bundleId": bundle_id, "displayIds": sorted(display_ids)})
    return result


def open_app(bundle_id: str) -> None:
    url = bundle_id_to_app(bundle_id)
    if not url:
        raise RuntimeError(f"App not found for bundle identifier: {bundle_id}")
    ok, err = NSWorkspace.sharedWorkspace().launchApplicationAtURL_options_configuration_error_(url, 0, {}, None)
    if not ok:
        raise RuntimeError(str(err) if err else f"Failed to open app {bundle_id}")


def read_clipboard() -> str:
    pb = NSPasteboard.generalPasteboard()
    value = pb.stringForType_(NSPasteboardTypeString)
    return "" if value is None else str(value)


def write_clipboard(text: str) -> None:
    pb = NSPasteboard.generalPasteboard()
    pb.clearContents()
    pb.setString_forType_(text, NSPasteboardTypeString)


def paste_clipboard() -> None:
    send_keystroke_via_osascript("v", ["command"])


def detect_screen_recording_permission() -> bool | None:
    """Best-effort passive screen-recording probe with no system prompt.

    `CGPreflightScreenCaptureAccess()` is fast and explicit when it returns
    True, but on child processes launched by a TCC-authorized app bundle it can
    still return False. As a fallback, inspect the visible window list: Apple
    only exposes other apps' window titles when Screen Recording access is
    granted. If we can see at least one title, treat the permission as granted.
    If we can inspect visible windows but every title is blank, treat it as not
    granted. If window enumeration itself is unavailable, return None.
    """

    try:
        if CGPreflightScreenCaptureAccess():
            return True
    except Exception:
        pass

    try:
        windows = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID,
        )
    except Exception:
        return None

    eligible_windows = 0
    for window in windows or []:
        if int(window.get(kCGWindowLayer, 0)) != 0:
            continue
        if not bool(window.get(kCGWindowIsOnscreen, True)):
            continue

        bounds = window.get(kCGWindowBounds) or {}
        width = int(bounds.get("Width", 0))
        height = int(bounds.get("Height", 0))
        if width <= 1 or height <= 1:
            continue

        eligible_windows += 1
        if (window.get(kCGWindowName, "") or "").strip():
            return True

    if eligible_windows > 0:
        return False
    return None


def detect_accessibility_permission() -> bool:
    """
    Use the official macOS Accessibility trust API.

    The previous System Events / AppleScript probe was too weak: it could
    succeed even when the current helper process was not actually trusted for
    input control, which led the desktop UI to report Accessibility as granted
    while mouse/keyboard control still failed at runtime.
    """
    framework_path = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    try:
        application_services = ctypes.CDLL(framework_path)
        application_services.AXIsProcessTrusted.restype = ctypes.c_bool
        application_services.AXIsProcessTrusted.argtypes = []
        return bool(application_services.AXIsProcessTrusted())
    except Exception:
        # Fail closed: if the trust API can't be queried, treat accessibility
        # as unavailable instead of reporting a misleading success state.
        return False


def check_permissions() -> dict[str, bool | None]:
    accessibility = detect_accessibility_permission()
    screen_recording = detect_screen_recording_permission()
    return {
        "accessibility": accessibility,
        "screenRecording": screen_recording,
    }


def click(x: int, y: int, button: str, count: int, modifiers: list[str] | None) -> None:
    pyautogui.moveTo(x, y)
    if modifiers:
        normalized = [normalize_key(m) for m in modifiers]
        for key in normalized:
            pyautogui.keyDown(key)
        try:
            pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)
        finally:
            for key in reversed(normalized):
                pyautogui.keyUp(key)
    else:
        pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)


def scroll(x: int, y: int, delta_x: int, delta_y: int) -> None:
    pyautogui.moveTo(x, y)
    if delta_y:
        pyautogui.scroll(int(delta_y), x=x, y=y)
    if delta_x:
        pyautogui.hscroll(int(delta_x), x=x, y=y)


def key_action(sequence: str, repeat: int = 1) -> None:
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    for _ in range(max(1, repeat)):
        if parts == ["command", "v"]:
            paste_clipboard()
        elif parts == ["command", "a"]:
            send_keystroke_via_osascript("a", ["command"])
        elif parts == ["command", "c"]:
            send_keystroke_via_osascript("c", ["command"])
        elif parts == ["command", "x"]:
            send_keystroke_via_osascript("x", ["command"])
        elif len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts, interval=0.02)
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
    pyautogui.write(text, interval=0.008)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()
    payload = json.loads(args.payload)

    try:
        command = args.command
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
            json_output({"ok": True, "result": True})
            return 0
        if command == "hold_key":
            hold_keys(list(payload.get("keyNames") or []), int(payload.get("durationMs") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "type":
            type_text(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        if command == "click":
            click(int(payload["x"]), int(payload["y"]), str(payload.get("button") or "left"), int(payload.get("count") or 1), payload.get("modifiers"))
            json_output({"ok": True, "result": True})
            return 0
        if command == "drag":
            from_point = payload.get("from")
            if from_point:
                pyautogui.moveTo(int(from_point["x"]), int(from_point["y"]))
            pyautogui.dragTo(int(payload["to"]["x"]), int(payload["to"]["y"]), duration=0.2, button="left")
            json_output({"ok": True, "result": True})
            return 0
        if command == "move_mouse":
            pyautogui.moveTo(int(payload["x"]), int(payload["y"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "scroll":
            scroll(int(payload["x"]), int(payload["y"]), int(payload.get("deltaX") or 0), int(payload.get("deltaY") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_down":
            pyautogui.mouseDown(button="left")
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_up":
            pyautogui.mouseUp(button="left")
            json_output({"ok": True, "result": True})
            return 0
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
            json_output({"ok": True, "result": True})
            return 0
        error_output(f"Unknown command: {command}", code="bad_command")
        return 2
    except Exception as exc:
        error_output(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
