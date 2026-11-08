from __future__ import annotations

import re

from oracle import atspi_raw as raw
from oracle.gsettings import tool
from runner.session import Tier

FRAME_ROLES = (16, 23, 69)
HEX_ID = re.compile(r"0[xX][0-9a-fA-F]+")
PRODUCT_ID = re.compile(r"w-(\d+\.\d+)-(.+)")


def window_ids(text: str) -> list[str]:
    if "=" not in text and "#" not in text:
        return []
    body = re.split(r"[=#]", text, maxsplit=1)[1]
    return [hex(int(value, 16)) for value in re.findall(r"0x[0-9a-fA-F]+", body)
            if int(value, 16)]


def decode_product_id(window: str) -> tuple[str, str]:
    match = PRODUCT_ID.fullmatch(window)
    if match is None:
        raise ValueError(f"{window!r} is not a product window id")
    bus, elements = match[1], match[2]
    return f":{bus}", "/" + elements.replace("-", "/")


def encode_product_id(bus: str, path: str) -> str:
    return "w-" + bus[1:] + "-" + path[1:].replace("/", "-")


def product_node(tier: Tier, window: str) -> "raw.RawNode":
    bus, path = decode_product_id(window)
    return raw.RawNode(raw.connect(tier.a11y_bus_address), bus, path)


def _pid(tier: Tier, xid: str) -> int | None:
    text = tool(tier, ["xprop", "-id", xid, "_NET_WM_PID"])
    match = re.search(r"=\s*(\d+)", text)
    return int(match[1]) if match else None


def _title(tier: Tier, xid: str) -> str:
    text = tool(tier, ["xprop", "-id", xid, "_NET_WM_NAME", "WM_NAME"])
    for pattern in (r'_NET_WM_NAME\([^)]*\)\s*=\s*"([^"]*)"', r'WM_NAME\([^)]*\)\s*=\s*"([^"]*)"'):
        match = re.search(pattern, text)
        if match:
            return match[1]
    return ""


def _frames(tier: Tier) -> list[tuple[int, str, str]]:
    frames = []
    for root in raw.registry(tier):
        pid = raw.owner_pid(root)
        for node in root.children():
            if node.role in FRAME_ROLES:
                frames.append((pid, node.name, encode_product_id(node.bus, node.path)))
    return frames


def product_window(tier: Tier, xid: str) -> str:
    frames = _frames(tier)
    pid = _pid(tier, xid)
    candidates = [item for item in frames if pid is not None and item[0] == pid]
    if len(candidates) > 1:
        title = _title(tier, xid)
        candidates = [item for item in candidates if item[1] == title]
    return candidates[0][2] if len(candidates) == 1 else xid


def xid(tier: Tier, window: str) -> str:
    if HEX_ID.fullmatch(window):
        return window.lower()
    try:
        node = product_node(tier, window)
        pid = raw.owner_pid(node)
        title = node.name
    except (ValueError, LookupError):
        raise ValueError(f"{window!r} is neither an X11 id nor a live product window id")
    candidates = []
    for candidate in window_ids(tool(tier, ["xprop", "-root", "_NET_CLIENT_LIST_STACKING"])):
        if _pid(tier, candidate) == pid:
            candidates.append(candidate)
    named = [candidate for candidate in candidates if _title(tier, candidate) == title]
    if len(named) == 1:
        return named[0]
    if len(candidates) == 1:
        return candidates[0]
    raise LookupError(f"the X11 window for {window!r} is not unambiguous")


def active_window(tier: Tier) -> str | None:
    ids = window_ids(tool(tier, ["xprop", "-root", "_NET_ACTIVE_WINDOW"]))
    return ids[0] if ids else None


def restore_active(tier: Tier, native_id: str) -> str | None:
    if not HEX_ID.fullmatch(native_id):
        raise ValueError("restoration needs a native X11 window id")
    tool(tier, ["wmctrl", "-ia", native_id])
    if not raw.poll(lambda: active_window(tier) == native_id, 5.0):
        raise AssertionError("the original active window was not restored")
    return active_window(tier)


def stacking_xids(tier: Tier) -> list[str]:
    return window_ids(tool(tier, ["xprop", "-root", "_NET_CLIENT_LIST_STACKING"]))


def stacking(tier: Tier) -> list[str]:
    return [product_window(tier, item) for item in stacking_xids(tier)]


def parse_geometry(text: str) -> tuple[int, int, int, int]:
    fields = ["Absolute upper-left X", "Absolute upper-left Y", "Width", "Height"]
    values = []
    for field in fields:
        match = re.search(rf"^\s*{field}:\s*(-?\d+)\s*$", text, re.MULTILINE)
        if match is None:
            raise ValueError(f"xwininfo omitted {field}")
        values.append(int(match[1]))
    if min(values[2:]) <= 0:
        raise ValueError("invalid window dimensions")
    return tuple(values)


def geometry(tier: Tier, window: str) -> tuple[int, int, int, int]:
    return parse_geometry(tool(tier, ["xwininfo", "-id", xid(tier, window)]))


def client_origin(tier: Tier, window: str) -> tuple[int, int]:
    return geometry(tier, window)[:2]


def parse_pointer(text: str) -> tuple[int, int]:
    fields = dict(re.findall(r"^(X|Y)=(-?\d+)$", text, re.MULTILINE))
    return int(fields["X"]), int(fields["Y"])


def pointer(tier: Tier) -> tuple[int, int]:
    return parse_pointer(tool(tier, ["xdotool", "getmouselocation", "--shell"]))


def set_above(tier: Tier, window: str, on: bool) -> None:
    tool(tier, ["wmctrl", "-ir", xid(tier, window), "-b", f"{'add' if on else 'remove'},above"])


def overview_active(tier: Tier) -> bool:
    return raw.call(raw.connect(tier.bus_address), "org.gnome.Shell", "/org/gnome/Shell",
                    "org.freedesktop.DBus.Properties", "Get", "(ss)",
                    ("org.gnome.Shell", "OverviewActive"))[0]
