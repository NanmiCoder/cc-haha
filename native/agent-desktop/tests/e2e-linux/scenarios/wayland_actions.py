from __future__ import annotations

from scenarios.headed_actions import find_ref as qualified_ref

import subprocess
import tempfile
import os
from pathlib import Path

from runner.apps import launch, stop
from runner import session
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import app_root
from oracle.x11 import encode_product_id

CALCULATOR = "Calculator"
REPO_ROOT = Path(__file__).resolve().parents[3]


def walk(node) -> list:
    nodes = [node]
    for child in node.children():
        nodes.extend(walk(child))
    return nodes


def shows(root, needle: str) -> bool:
    for node in walk(root):
        if getattr(node, "name", "") == needle:
            return True
        text = node.text()
        if text is not None and text.strip() == needle:
            return True
    return False


def search(value, needle: str) -> bool:
    target = needle.lower()
    if isinstance(value, str):
        return target in value.lower()
    if isinstance(value, dict):
        return any(search(key, needle) or search(item, needle) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(search(item, needle) for item in value)
    return False


def code_of(envelope) -> str:
    return str((envelope.error or {}).get("code", ""))


def named_ref(tree: dict | None, name: str) -> str | None:
    return qualified_ref(tree, name=name)


def _error_text(envelope) -> dict:
    return {"message": (envelope.error or {}).get("message", ""), "details": (envelope.error or {}).get("details")}


def _window_state(ctx):
    root = app_root(ctx.tier, "gnome-calculator")
    frames = [node for node in root.children() if node.role in (23, 69)]
    assert frames, "the independent oracle found no Calculator window"
    return sorted((encode_product_id(node.bus, node.path), tuple(sorted(node.states)),
                   tuple(sorted(child.path for child in walk(node) if "FOCUSED" in child.states)))
                  for node in frames)


@implementation("wayland_actions.focus_window_wayland_session_refusal")
def focus_window_wayland_session_refusal(ctx: LegContext) -> None:
    app = launch(ctx.tier, CALCULATOR)
    try:
        before = _window_state(ctx)
        ctx.before("atspi.focus", before)
        windows = ctx.product(["list-windows", "--app", CALCULATOR])
        assert windows.ok and windows.data, windows.raw
        assert {item["id"] for item in windows.data} == {item[0] for item in before}, "fabricated window IDs"
        window_id = windows.data[0]["id"]
        envelope = ctx.product(["focus-window", "--window-id", window_id])
        after = _window_state(ctx)
        ctx.after("atspi.focus", after)
        assert after == before, "focus changed despite refusal"
        assert not envelope.ok, envelope.raw
        assert code_of(envelope) == "ACTION_NOT_SUPPORTED", envelope.raw
        assert search(_error_text(envelope), "wayland_session"), envelope.raw
        ctx.restored("atspi.focus", _window_state(ctx))
    finally:
        stop(app)


@implementation("wayland_actions.list_windows_no_position")
def list_windows_no_position(ctx: LegContext) -> None:
    app = launch(ctx.tier, CALCULATOR)
    try:
        before = _window_state(ctx)
        ctx.before("atspi.windows", before)
        envelope = ctx.product(["list-windows", "--app", CALCULATOR])
        assert envelope.ok and envelope.data, envelope.raw
        assert len(envelope.data) == len(before), "product and independent window counts differ"
        assert {item["id"] for item in envelope.data} == {item[0] for item in before}, "fabricated window IDs"
        assert all("bounds" not in item for item in envelope.data), envelope.data
        after = _window_state(ctx)
        ctx.after("atspi.windows", after)
        assert after == before, "listing windows changed independent window state"
        ctx.restored("atspi.windows", _window_state(ctx))
    finally:
        stop(app)


@implementation("wayland_actions.unhealthy_shell_named_reason")
def unhealthy_shell_named_reason(ctx: LegContext) -> None:
    script = REPO_ROOT / "scripts" / "private-wayland-shell.sh"
    with tempfile.TemporaryDirectory(prefix="unhealthy-", dir=ctx.tier.runtime_dir) as directory:
        root = Path(directory)
        starts, clients = root / "starts", root / "clients"
        tools = root / "bin"
        tools.mkdir()
        for name, body in {
            "gnome-shell": 'echo start >> "$PROBE_STARTS"; touch "$XDG_RUNTIME_DIR/wayland-probe"; exec /bin/sleep 300',
            "python3": 'echo client >> "$PROBE_CLIENTS"; exit 1',
            "sleep": 'exec /bin/sleep 0.01',
        }.items():
            path = tools / name
            path.write_text("#!/bin/sh\n" + body + "\n")
            path.chmod(0o700)
        env = dict(ctx.tier.env, XDG_RUNTIME_DIR=str(root),
                   AGENT_DESKTOP_PRIVATE_SESSION=str(root),
                   PATH=str(tools) + os.pathsep + ctx.tier.env["PATH"],
                   PROBE_STARTS=str(starts), PROBE_CLIENTS=str(clients))
        read = lambda: root.is_dir()
        ctx.before("proc.runtime", read())
        ctx.before("proc.members", session._proc_members(root))
        try:
            completed = subprocess.run(["bash", str(script), "--", "touch", str(root / "payload")],
                                       env=env, capture_output=True, text=True, timeout=30, check=False)
            remaining = session._proc_members(root)
            ctx.after("proc.members", remaining)
            assert not remaining, "unhealthy-shell probe leaked private members"
        finally:
            assert not session._sweep_members(root), "unhealthy-shell probe left private members"
        ctx.after("proc.runtime", read())
        assert completed.returncode == 1, completed.stdout + completed.stderr
        assert "no healthy gnome-shell after 8 starts" in completed.stderr, completed.stderr
        assert starts.read_text().splitlines() == ["start"] * 8
        assert clients.read_text().splitlines() == ["client"] * 8
        assert not (root / "payload").exists(), "payload ran without a healthy client"
        ctx.restored("proc.runtime", read())
        ctx.restored("proc.members", session._proc_members(root))
