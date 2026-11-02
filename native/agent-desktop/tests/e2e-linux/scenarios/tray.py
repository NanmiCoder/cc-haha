from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

from apps.sni_item import read_log
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import call, connect, poll
from oracle.gsettings import tool

SENDER = Path(__file__).resolve().parents[1] / "apps" / "sni_item.py"
SERVICE = "org.agentdesktop.HarnessTray"
TITLE = "Harness Tray"
ACTIVATE_LABEL = "Activate Harness Item"


def calls_named(path: Path, name: str) -> list[dict]:
    return [payload for call, payload in read_log(path) if call == name]


def _start(ctx: LegContext, log, *flags: str):
    argv = [sys.executable, str(SENDER), "--log", str(log), "--title", TITLE, *flags]
    spawned = subprocess.Popen(
        argv, env=ctx.tier.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    try:
        ready = poll(lambda: calls_named(log, "registered") or calls_named(log, "register_failed"), 15.0)
        assert ready and not calls_named(log, "register_failed"), read_log(log)
    except BaseException:
        _stop(spawned)
        raise
    return spawned


def _stop(spawned) -> None:
    if spawned.poll() is not None:
        return
    try:
        os.kill(spawned.pid, signal.SIGTERM)
        spawned.wait(timeout=10)
    except ProcessLookupError:
        spawned.wait(timeout=10)
    except subprocess.TimeoutExpired:
        spawned.kill()
        spawned.wait(timeout=10)


def _watcher_ready(ctx: LegContext) -> bool:
    completed = subprocess.run(
        ["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus",
         "--object-path", "/org/freedesktop/DBus", "--method",
         "org.freedesktop.DBus.NameHasOwner", "org.kde.StatusNotifierWatcher"],
        env=ctx.tier.env, capture_output=True, text=True, timeout=5, check=True,
    )
    return completed.stdout.strip() == "(true,)"


def watcher_items(ctx):
    return call(connect(ctx.tier.bus_address), "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties", "Get", "(ss)",
                ("org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"))[0]


def service_owner(ctx):
    return call(connect(ctx.tier.bus_address), "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetNameOwner", "(s)", (SERVICE,))[0]


def owner_present(ctx, owner):
    return call(connect(ctx.tier.bus_address), "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "NameHasOwner", "(s)", (owner,))[0]


@contextmanager
def enabled_watcher(ctx):
    assert ctx.tier.name == "x11-mutter"
    watcher_before = _watcher_ready(ctx)
    previous = tool(ctx.tier, ["gsettings", "get", "org.gnome.shell", "enabled-extensions"])
    try:
        tool(ctx.tier, ["gsettings", "set", "org.gnome.shell", "enabled-extensions",
                        "['ubuntu-appindicators@ubuntu.com']"])
        assert poll(lambda: _watcher_ready(ctx), 10.0), "private tray watcher never appeared"
        yield
    finally:
        tool(ctx.tier, ["gsettings", "set", "org.gnome.shell", "enabled-extensions", previous])
        assert tool(ctx.tier, ["gsettings", "get", "org.gnome.shell", "enabled-extensions"]) == previous
        assert poll(lambda: _watcher_ready(ctx) == watcher_before, 10.0), "watcher did not restore"


@contextmanager
def sender(ctx, *flags):
    with enabled_watcher(ctx):
        baseline = watcher_items(ctx)
        ctx.before("dbus.items", baseline)
        descriptor, path = tempfile.mkstemp(prefix="tray-", suffix=".log", dir=ctx.tier.runtime_dir)
        os.close(descriptor)
        log = Path(path)
        ctx.before("applog", read_log(log))
        spawned = None
        try:
            spawned = _start(ctx, log, *flags)
            owner = service_owner(ctx)
            assert call(connect(ctx.tier.bus_address), "org.freedesktop.DBus", "/org/freedesktop/DBus",
                        "org.freedesktop.DBus", "GetConnectionUnixProcessID", "(s)", (owner,))[0] == spawned.pid
            assert poll(lambda: SERVICE in watcher_items(ctx), 5.0), watcher_items(ctx)
            yield spawned, log
            ctx.after("dbus.items", watcher_items(ctx))
        finally:
            if spawned is not None:
                _stop(spawned)
            assert poll(lambda: watcher_items(ctx) == baseline, 5.0), "watcher items did not restore"
            ctx.restored("dbus.items", watcher_items(ctx))
            log.unlink(missing_ok=True)
            ctx.restored("applog", read_log(log))


def _ref(ctx: LegContext, name: str) -> str:
    envelope = ctx.product(["snapshot", "--surface", "system-tray", "-i"])
    assert envelope.ok, envelope.raw
    stack = [(envelope.data or {}).get("tree")]
    while stack:
        node = stack.pop()
        if not node:
            continue
        if node.get("ref_id") and node.get("name") == name:
            return node["ref_id"]
        stack.extend(node.get("children") or [])
    raise AssertionError(f"the tray snapshot has no ref named {name!r}: {envelope.raw}")


@implementation("tray.headless_activate_logged")
def headless_activate_logged(ctx: LegContext) -> None:
    with sender(ctx) as (_spawned, log):
        ref = _ref(ctx, TITLE)
        assert not calls_named(log, "Activate")
        envelope = ctx.product(["click", ref])
        assert envelope.ok, envelope.raw
        assert poll(lambda: calls_named(log, "Activate"), 5.0), "no Activate reached the sender"
        assert calls_named(log, "Activate") == [{"values": [0, 0]}]
        ctx.after("applog", read_log(log))


@implementation("tray.headless_menu_event_clicked")
def headless_menu_event_clicked(ctx: LegContext) -> None:
    with sender(ctx) as (_spawned, log):
        ref = _ref(ctx, ACTIVATE_LABEL)
        assert not calls_named(log, "Event")
        envelope = ctx.product(["click", ref])
        assert envelope.ok, envelope.raw
        assert poll(lambda: calls_named(log, "Event"), 5.0), "no Event reached the sender"
        assert calls_named(log, "Event") == [{"id": 1, "event": "clicked"}]
        ctx.after("applog", read_log(log))


@implementation("tray.item_without_activate_refused")
def item_without_activate_refused(ctx: LegContext) -> None:
    with sender(ctx, "--no-activate") as (_spawned, log):
        ref = _ref(ctx, TITLE)
        envelope = ctx.product(["click", ref])
        assert not envelope.ok, envelope.raw
        assert (envelope.error or {}).get("code") == "POLICY_DENIED", envelope.raw
        assert (envelope.error or {}).get("disposition", {}).get("delivery") == "not_delivered", envelope.raw
        assert not calls_named(log, "Activate")
        ctx.after("applog", read_log(log))


@implementation("tray.killed_owner_stale_ref")
def killed_owner_stale_ref(ctx: LegContext) -> None:
    with sender(ctx) as (spawned, log):
        ref = _ref(ctx, TITLE)
        owner = service_owner(ctx)
        _stop(spawned)
        assert spawned.poll() is not None
        assert poll(lambda: not owner_present(ctx, owner), 5.0), "sender bus owner did not exit"
        envelope = ctx.product(["click", ref])
        assert not envelope.ok, envelope.raw
        assert (envelope.error or {}).get("code") == "STALE_REF", envelope.raw
        assert not calls_named(log, "Activate")
        ctx.after("applog", read_log(log))
