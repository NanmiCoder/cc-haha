#!/usr/bin/env python3
"""Windows virtual cursor overlay.

The first Windows implementation drew a 168x30 text banner beside the system
cursor. Apart from looking unlike the macOS feature,
that window followed the user's pointer as well as Computer Use and was not
per-monitor-DPI aware, so it could float over the wrong application and at the
wrong coordinates.

This process renders the same visual language as the native macOS helper: a
blue pointer with a white keyline, breathing halo, idle bob, and click ripple.
It observes the low-level mouse stream and follows injected movement only. The
real Windows pointer still has to move because Windows has no ``postToPid``
equivalent, but the virtual cursor is co-located with that pointer during agent
movement and stays at the agent's last point if the user takes the mouse.

The parent sends one JSON line for each action and closes stdin at turn end.
The window is per-pixel-alpha, topmost, click-through, absent from Alt-Tab, and
never activates. Visual failures remain advisory and never block input.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import sys
import threading
import time
from ctypes import wintypes

from PIL import Image, ImageChops, ImageDraw, ImageFilter


user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_POPUP = 0x80000000

SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
HWND_TOPMOST = wintypes.HWND(-1)
SWP_NOACTIVATE = 0x0010

WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_NCHITTEST = 0x0084
WM_TIMER = 0x0113
WM_MOUSEMOVE = 0x0200
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
WM_RBUTTONUP = 0x0205
WM_MBUTTONDOWN = 0x0207
WM_MBUTTONUP = 0x0208
WM_MOUSEWHEEL = 0x020A
WM_MOUSEHWHEEL = 0x020E

HTTRANSPARENT = -1
WH_MOUSE_LL = 14
HC_ACTION = 0
LLMHF_INJECTED = 0x00000001
LLMHF_LOWER_IL_INJECTED = 0x00000002

ULW_ALPHA = 0x00000002
AC_SRC_OVER = 0x00
AC_SRC_ALPHA = 0x01
DIB_RGB_COLORS = 0
BI_RGB = 0
GW_HWNDNEXT = 2
GWL_EXSTYLE = -20
MONITOR_DEFAULTTONEAREST = 2
MDT_EFFECTIVE_DPI = 0
INPUT_TAG_ENV = "CC_HAHA_COMPUTER_USE_INPUT_TAG"

# Windows 10 1703+. Negative pseudo-handles are the documented ABI values.
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

# Logical-point geometry mirrors VirtualCursorStyle.swift. The overlay is
# scaled to the current monitor's DPI before it reaches UpdateLayeredWindow.
CANVAS_SIZE = 76
HOTSPOT = (32.0, 30.0)
ARROW_HEIGHT = 22.0
ARROW_POINTS = (
    (0.0, 0.0),
    (0.0, 16.5),
    (4.0, 12.7),
    (6.6, 18.5),
    (9.2, 17.4),
    (6.6, 11.6),
    (11.6, 11.2),
)
HALO_DIAMETER = ARROW_HEIGHT * 2.4
IDLE_BOB_AMPLITUDE = 1.5
IDLE_BOB_PERIOD = 1.8
HALO_BREATH_PERIOD = 2.4
TIMER_ID = 1
TIMER_INTERVAL_MS = 16


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


class SIZE(ctypes.Structure):
    _fields_ = [("cx", wintypes.LONG), ("cy", wintypes.LONG)]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class BLENDFUNCTION(ctypes.Structure):
    _fields_ = [
        ("BlendOp", ctypes.c_ubyte),
        ("BlendFlags", ctypes.c_ubyte),
        ("SourceConstantAlpha", ctypes.c_ubyte),
        ("AlphaFormat", ctypes.c_ubyte),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class RGBQUAD(ctypes.Structure):
    _fields_ = [
        ("rgbBlue", ctypes.c_ubyte),
        ("rgbGreen", ctypes.c_ubyte),
        ("rgbRed", ctypes.c_ubyte),
        ("rgbReserved", ctypes.c_ubyte),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", RGBQUAD * 1)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("pt", POINT),
        ("mouseData", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(
    LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
)
HOOKPROC = ctypes.WINFUNCTYPE(
    LRESULT, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
)


class WNDCLASS(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


def _enable_per_monitor_dpi_awareness() -> None:
    """Make pointer, window, and screenshot coordinates all physical pixels."""
    try:
        setter = user32.SetProcessDpiAwarenessContext
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
        user32.SetProcessDPIAware()
    except (AttributeError, OSError):
        pass


def _configure_win32() -> None:
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GetModuleHandleW.restype = wintypes.HINSTANCE

    user32.RegisterClassW.argtypes = [ctypes.POINTER(WNDCLASS)]
    user32.RegisterClassW.restype = wintypes.WORD
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HANDLE, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.DefWindowProcW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    user32.DefWindowProcW.restype = LRESULT
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.PostQuitMessage.argtypes = [ctypes.c_int]
    user32.PostQuitMessage.restype = None
    user32.PostMessageW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT,
    ]
    user32.GetMessageW.restype = ctypes.c_int
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
    user32.DispatchMessageW.restype = LRESULT
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, wintypes.LPVOID]
    user32.SetTimer.restype = ctypes.c_size_t
    user32.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
    user32.KillTimer.restype = wintypes.BOOL

    user32.SetWindowsHookExW.argtypes = [
        ctypes.c_int, HOOKPROC, wintypes.HINSTANCE, wintypes.DWORD,
    ]
    user32.SetWindowsHookExW.restype = wintypes.HANDLE
    user32.CallNextHookEx.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM,
    ]
    user32.CallNextHookEx.restype = LRESULT
    user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
    user32.UnhookWindowsHookEx.restype = wintypes.BOOL

    user32.UpdateLayeredWindow.argtypes = [
        wintypes.HWND, wintypes.HDC, ctypes.POINTER(POINT), ctypes.POINTER(SIZE),
        wintypes.HDC, ctypes.POINTER(POINT), wintypes.DWORD,
        ctypes.POINTER(BLENDFUNCTION), wintypes.DWORD,
    ]
    user32.UpdateLayeredWindow.restype = wintypes.BOOL
    user32.GetDpiForWindow.argtypes = [wintypes.HWND]
    user32.GetDpiForWindow.restype = wintypes.UINT
    user32.MonitorFromPoint.argtypes = [POINT, wintypes.DWORD]
    user32.MonitorFromPoint.restype = wintypes.HANDLE
    user32.WindowFromPoint.argtypes = [POINT]
    user32.WindowFromPoint.restype = wintypes.HWND
    user32.GetForegroundWindow.argtypes = []
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetTopWindow.argtypes = [wintypes.HWND]
    user32.GetTopWindow.restype = wintypes.HWND
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long

    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.DeleteDC.restype = wintypes.BOOL
    gdi32.CreateDIBSection.argtypes = [
        wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
        ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD,
    ]
    gdi32.CreateDIBSection.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HANDLE]
    gdi32.SelectObject.restype = wintypes.HANDLE
    gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
    gdi32.DeleteObject.restype = wintypes.BOOL

    try:
        shcore = ctypes.windll.shcore
        shcore.GetDpiForMonitor.argtypes = [
            wintypes.HANDLE, ctypes.c_int,
            ctypes.POINTER(wintypes.UINT), ctypes.POINTER(wintypes.UINT),
        ]
        shcore.GetDpiForMonitor.restype = ctypes.c_long
    except (AttributeError, OSError):
        pass


_enable_per_monitor_dpi_awareness()
_configure_win32()


def _pid_for_window(hwnd: int | None) -> int | None:
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value) or None


def _input_tag() -> int | None:
    try:
        value = int(os.environ[INPUT_TAG_ENV]) & 0xFFFFFFFF
        return value or None
    except (KeyError, TypeError, ValueError):
        return None


def _dpi_at_point(point: tuple[int, int], hwnd: int) -> int:
    """Return the DPI of the destination monitor before moving the overlay."""
    try:
        monitor = user32.MonitorFromPoint(
            POINT(point[0], point[1]), MONITOR_DEFAULTTONEAREST,
        )
        dpi_x = wintypes.UINT()
        dpi_y = wintypes.UINT()
        if monitor and ctypes.windll.shcore.GetDpiForMonitor(
            monitor, MDT_EFFECTIVE_DPI, ctypes.byref(dpi_x), ctypes.byref(dpi_y),
        ) == 0:
            return int(dpi_x.value) or 96
    except (AttributeError, OSError):
        pass
    return int(user32.GetDpiForWindow(hwnd)) or 96


def _point_from_activity(command: str, payload: dict) -> tuple[int, int] | None:
    if command == "drag":
        point = payload.get("to") or {}
        if "x" in point and "y" in point:
            return int(point["x"]), int(point["y"])
        return None
    if command in {"click", "move_mouse", "scroll"}:
        if "x" in payload and "y" in payload:
            return int(payload["x"]), int(payload["y"])
    return None


def _premultiplied_bgra(image: Image.Image) -> bytes:
    red, green, blue, alpha = image.split()
    return Image.merge("RGBA", (
        ImageChops.multiply(blue, alpha),
        ImageChops.multiply(green, alpha),
        ImageChops.multiply(red, alpha),
        alpha,
    )).tobytes()


def _render_cursor(scale: float, now: float, click: tuple[float, int] | None) -> Image.Image:
    """Render one anti-aliased frame using the native helper's dimensions."""
    size = max(1, round(CANVAS_SIZE * scale))
    antialias = 3
    factor = scale * antialias
    image = Image.new("RGBA", (size * antialias, size * antialias), (0, 0, 0, 0))

    breath = (math.sin((now / HALO_BREATH_PERIOD) * math.tau - math.pi / 2) + 1) / 2
    halo_scale = 0.86 + breath * 0.28
    halo_alpha = 0.5 + breath * 0.5
    arrow_scale = ARROW_HEIGHT / 19.0
    bob = math.sin((now / IDLE_BOB_PERIOD) * math.tau) * IDLE_BOB_AMPLITUDE

    tip_x = HOTSPOT[0] * factor
    tip_y = HOTSPOT[1] * factor
    arrow_points = [
        (
            tip_x + x * arrow_scale * factor,
            tip_y + (y * arrow_scale + bob) * factor,
        )
        for x, y in ARROW_POINTS
    ]

    arrow_width = max(x for x, _ in ARROW_POINTS) * arrow_scale
    halo_center = (
        tip_x + arrow_width * factor / 2,
        tip_y + ARROW_HEIGHT * factor / 2,
    )
    halo_radius = HALO_DIAMETER * halo_scale * factor / 2
    halo = Image.new("RGBA", image.size, (0, 0, 0, 0))
    halo_draw = ImageDraw.Draw(halo)
    halo_draw.ellipse(
        (
            halo_center[0] - halo_radius,
            halo_center[1] - halo_radius,
            halo_center[0] + halo_radius,
            halo_center[1] + halo_radius,
        ),
        fill=(38, 140, 255, round(107 * halo_alpha)),
    )
    halo = halo.filter(ImageFilter.GaussianBlur(max(1, round(7 * factor))))
    image = Image.alpha_composite(image, halo)

    if click is not None:
        started, kind = click
        progress = min(1.0, max(0.0, (now - started) / 0.38))
        if progress < 1:
            ripple = ImageDraw.Draw(image)
            radius = (7 + 21 * progress) * factor
            alpha = round(230 * (1 - progress))
            color = (255, 149, 0, alpha) if kind == WM_RBUTTONDOWN else (77, 158, 255, alpha)
            width = max(1, round(2.5 * factor))
            ripple.ellipse(
                (tip_x - radius, tip_y - radius, tip_x + radius, tip_y + radius),
                outline=color,
                width=width,
            )
            pulse = 1.0 - 0.2 * math.sin(progress * math.pi)
            arrow_points = [
                (tip_x + (x - tip_x) * pulse, tip_y + (y - tip_y) * pulse)
                for x, y in arrow_points
            ]

    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.polygon(
        [(x, y + factor) for x, y in arrow_points],
        fill=(0, 0, 0, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(1, round(3 * factor))))
    image = Image.alpha_composite(image, shadow)

    arrow = ImageDraw.Draw(image)
    outline_width = max(1, round(1.5 * factor))
    arrow.polygon(arrow_points, fill="#0075f2")
    arrow.line(
        [*arrow_points, arrow_points[0]],
        fill="white",
        width=outline_width,
        joint="curve",
    )

    return image.resize((size, size), Image.Resampling.LANCZOS)


class VirtualCursorOverlay:
    def __init__(self) -> None:
        self.hwnd: int | None = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._agent_position: tuple[int, int] | None = None
        self._destination: tuple[int, int] | None = None
        self._target_pid: int | None = None
        self._requested_visible = False
        self._hidden_for_user = False
        self._click: tuple[float, int] | None = None
        self._shown = False
        self._mouse_hook: int | None = None
        self._input_tag = _input_tag()
        self._wndproc = WNDPROC(self._on_message)
        self._hookproc = HOOKPROC(self._on_mouse_hook)

    def _on_message(self, hwnd, msg, wparam, lparam):
        if msg == WM_NCHITTEST:
            return HTTRANSPARENT
        if msg == WM_TIMER and int(wparam) == TIMER_ID:
            self._tick()
            return 0
        if msg == WM_CLOSE:
            user32.DestroyWindow(hwnd)
            return 0
        if msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _on_mouse_hook(self, code, wparam, lparam):
        if code == HC_ACTION:
            info = ctypes.cast(lparam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
            injected = bool(info.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED))
            agent_injected = (
                injected
                and self._input_tag is not None
                and int(info.dwExtraInfo) & 0xFFFFFFFF == self._input_tag
            )
            event = int(wparam)
            with self._lock:
                if agent_injected:
                    self._agent_position = (int(info.pt.x), int(info.pt.y))
                    if self._target_pid is None:
                        self._target_pid = self._pid_at_point(self._agent_position)
                    self._requested_visible = self._target_pid is not None
                    self._hidden_for_user = False
                    if event in {WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN}:
                        self._click = (time.monotonic(), event)
                elif event in {
                    WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP,
                    WM_RBUTTONDOWN, WM_RBUTTONUP, WM_MBUTTONDOWN,
                    WM_MBUTTONUP, WM_MOUSEWHEEL, WM_MOUSEHWHEEL,
                }:
                    # Physical input means the user has taken the shared Windows
                    # pointer. Keep our logical position but hide until the next
                    # injected event, so the overlay never follows their hand.
                    self._hidden_for_user = True
        return user32.CallNextHookEx(self._mouse_hook, code, wparam, lparam)

    def _pid_at_point(self, point: tuple[int, int]) -> int | None:
        # This is called before the first reveal for each destination, so the
        # direct API resolves the controlled window rather than this overlay.
        hwnd = user32.WindowFromPoint(POINT(*point))
        if hwnd and int(hwnd) != int(self.hwnd or 0):
            return _pid_for_window(hwnd)
        return self._top_window_pid_at(point)

    def _top_window_pid_at(self, point: tuple[int, int]) -> int | None:
        hwnd = user32.GetTopWindow(None)
        while hwnd:
            if int(hwnd) != int(self.hwnd or 0) and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
                style = int(user32.GetWindowLongW(hwnd, GWL_EXSTYLE))
                rect = RECT()
                if not (style & WS_EX_TRANSPARENT) and user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    if rect.left <= point[0] < rect.right and rect.top <= point[1] < rect.bottom:
                        pid = _pid_for_window(hwnd)
                        if pid and pid != os.getpid():
                            return pid
            hwnd = user32.GetWindow(hwnd, GW_HWNDNEXT)
        return None

    def _target_is_visible(self, target_pid: int, destination: tuple[int, int]) -> bool:
        foreground_pid = _pid_for_window(user32.GetForegroundWindow())
        return foreground_pid == target_pid or self._top_window_pid_at(destination) == target_pid

    def _on_activity(self, message: dict) -> None:
        command = str(message.get("command") or "")
        payload = message.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        point = _point_from_activity(command, payload)
        raw_target_pid = message.get("targetPid")
        target_pid = int(raw_target_pid) if isinstance(raw_target_pid, int) and raw_target_pid > 0 else None

        with self._lock:
            if point is not None:
                # Keep the cursor visible between related actions. Hiding here
                # made every movement reappear only after the first injected
                # frame, which looked like a jump into the middle of the path.
                # `_pid_at_point` already skips this transparent overlay.
                self._destination = point
                self._target_pid = target_pid or self._pid_at_point(point)
                if self._agent_position is None:
                    current = POINT()
                    if user32.GetCursorPos(ctypes.byref(current)):
                        self._agent_position = (int(current.x), int(current.y))
                self._requested_visible = self._target_pid is not None
                self._hidden_for_user = False
            elif target_pid is not None:
                self._target_pid = target_pid

    def _read_parent(self) -> None:
        try:
            for line in sys.stdin:
                try:
                    message = json.loads(line)
                    if isinstance(message, dict):
                        self._on_activity(message)
                except (TypeError, ValueError):
                    continue
        except Exception:
            pass
        self.stop()

    def create(self) -> None:
        hinst = kernel32.GetModuleHandleW(None)
        class_name = "CcHahaVirtualCursorOverlay"
        wc = WNDCLASS()
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinst
        wc.lpszClassName = class_name
        wc.hbrBackground = 0
        wc.hCursor = 0
        user32.RegisterClassW(ctypes.byref(wc))

        self.hwnd = user32.CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST
            | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name, None, WS_POPUP,
            0, 0, CANVAS_SIZE, CANVAS_SIZE,
            None, None, hinst, None,
        )
        if not self.hwnd:
            raise OSError("CreateWindowExW failed for the virtual cursor")

        self._mouse_hook = user32.SetWindowsHookExW(WH_MOUSE_LL, self._hookproc, None, 0)
        if not self._mouse_hook:
            raise OSError("SetWindowsHookExW failed for the virtual cursor")
        if not user32.SetTimer(self.hwnd, TIMER_ID, TIMER_INTERVAL_MS, None):
            raise OSError("SetTimer failed for the virtual cursor")

    def _tick(self) -> None:
        if not self.hwnd:
            return
        with self._lock:
            position = self._agent_position
            destination = self._destination
            target_pid = self._target_pid
            visible = self._requested_visible and not self._hidden_for_user
            click = self._click

        if visible and position and destination and target_pid:
            visible = self._target_is_visible(target_pid, destination)
        else:
            visible = False

        if not visible:
            if self._shown:
                user32.ShowWindow(self.hwnd, SW_HIDE)
                self._shown = False
            return

        assert position is not None
        dpi = _dpi_at_point(position, self.hwnd)
        scale = max(1.0, dpi / 96.0)
        image = _render_cursor(scale, time.monotonic(), click)
        left = round(position[0] - HOTSPOT[0] * scale)
        top = round(position[1] - HOTSPOT[1] * scale)
        self._update_layered_image(image, left, top)
        if not self._shown:
            user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
            self._shown = True

    def _update_layered_image(self, image: Image.Image, left: int, top: int) -> None:
        assert self.hwnd is not None
        width, height = image.size
        bmi = BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = width
        bmi.bmiHeader.biHeight = -height  # top-down DIB, same orientation as Pillow
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = BI_RGB

        bits = ctypes.c_void_p()
        memory_dc = gdi32.CreateCompatibleDC(None)
        bitmap = gdi32.CreateDIBSection(
            memory_dc, ctypes.byref(bmi), DIB_RGB_COLORS,
            ctypes.byref(bits), None, 0,
        )
        if not memory_dc or not bitmap or not bits.value:
            if bitmap:
                gdi32.DeleteObject(bitmap)
            if memory_dc:
                gdi32.DeleteDC(memory_dc)
            return

        previous = gdi32.SelectObject(memory_dc, bitmap)
        try:
            pixels = _premultiplied_bgra(image)
            ctypes.memmove(bits, pixels, len(pixels))
            destination = POINT(left, top)
            size = SIZE(width, height)
            source = POINT(0, 0)
            blend = BLENDFUNCTION(AC_SRC_OVER, 0, 255, AC_SRC_ALPHA)
            user32.UpdateLayeredWindow(
                self.hwnd, None, ctypes.byref(destination), ctypes.byref(size),
                memory_dc, ctypes.byref(source), 0, ctypes.byref(blend), ULW_ALPHA,
            )
            user32.SetWindowPos(
                self.hwnd, HWND_TOPMOST, left, top, width, height, SWP_NOACTIVATE,
            )
        finally:
            if previous:
                gdi32.SelectObject(memory_dc, previous)
            gdi32.DeleteObject(bitmap)
            gdi32.DeleteDC(memory_dc)

    def stop(self) -> None:
        self._stop.set()
        if self.hwnd:
            user32.PostMessageW(self.hwnd, WM_CLOSE, 0, 0)

    def run(self) -> int:
        self.create()
        threading.Thread(target=self._read_parent, daemon=True).start()
        # The TypeScript bridge waits for this handshake before dispatching the
        # first SendInput action, so the low-level hook cannot miss its movement.
        print("READY", flush=True)

        msg = wintypes.MSG()
        while not self._stop.is_set() and user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

        if self.hwnd:
            user32.KillTimer(self.hwnd, TIMER_ID)
        if self._mouse_hook:
            user32.UnhookWindowsHookEx(self._mouse_hook)
            self._mouse_hook = None
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    # Kept for compatibility with already-running parents from the previous
    # runtime; labels are intentionally no longer rendered.
    parser.add_argument("--label", default=None, help=argparse.SUPPRESS)
    parser.parse_args()
    if sys.platform != "win32":
        print("win_cursor_badge.py is Windows-only", file=sys.stderr)
        return 1
    return VirtualCursorOverlay().run()


if __name__ == "__main__":
    raise SystemExit(main())
