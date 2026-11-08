from __future__ import annotations

import re
import subprocess
from contextlib import contextmanager
from pathlib import Path

from runner.session import Tier
from oracle import atspi_raw as raw, proc

REPO_ROOT = Path(__file__).resolve().parents[3]
ORACLE_SCRIPT = REPO_ROOT / "scripts" / "notification-oracle.sh"


def _script_path() -> Path:
    return ORACLE_SCRIPT


def notification_argv(
    app: str,
    summary: str,
    body: str = "",
    actions: tuple[tuple[str, str], ...] = (),
    *,
    script: Path | None = None,
) -> list[str]:
    path = script or _script_path()
    return ["bash", str(path), "notify", app, summary, body,
            ",".join(f"{key}={label}" for key, label in actions)]


def monitor_argv() -> list[str]:
    return [
        "dbus-monitor",
        "--session",
        "type='signal',interface='org.freedesktop.DBus',member='NameLost'",
        "type='signal',interface='org.freedesktop.Notifications'",
    ]


def parse_notification_id(stdout: str) -> int:
    found = re.findall(r"\d+", stdout)
    if not found:
        raise ValueError(f"no notification id in oracle output: {stdout!r}")
    return int(found[-1])


def send(
    tier: Tier,
    app: str,
    summary: str,
    body: str = "",
    actions: tuple[tuple[str, str], ...] = (),
) -> int:
    argv = notification_argv(app, summary, body, actions)
    completed = subprocess.run(
        argv, env=tier.env, capture_output=True, text=True, timeout=25, check=False
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"notification oracle failed ({completed.returncode}): {completed.stderr.strip()}"
        )
    return parse_notification_id(completed.stdout)


def monitor(tier: Tier, path: Path) -> subprocess.Popen:
    handle = open(path, "w", encoding="utf-8")
    try:
        spawned = subprocess.Popen(
            monitor_argv(),
            env=tier.env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    finally:
        handle.close()
    return spawned


def parse_monitor_text(text: str) -> list[tuple[str, dict]]:
    signals: list[tuple[str, dict]] = []
    for block in re.split(r"(?=^signal )", text, flags=re.M):
        member = re.search(r"member=(\w+)", block)
        if not member:
            continue
        name = member.group(1)
        if name == "NotificationClosed":
            values = [int(v) for v in re.findall(r"^\s+uint32 (\d+)$", block, re.M)]
            if len(values) >= 2:
                signals.append((name, {"id": values[0], "reason": values[1]}))
        elif name == "ActionInvoked":
            numbers = re.findall(r"^\s+uint32 (\d+)$", block, re.M)
            strings = re.findall(r'^\s+string "(.*)"$', block, re.M)
            if numbers:
                signals.append(
                    (
                        name,
                        {"id": int(numbers[0]), "action": strings[0] if strings else ""},
                    )
                )
    return signals


class Sender:
    def __init__(self, tier, path):
        self.tier = tier
        self.path = path
        self.records = {}

    def signals(self):
        return parse_monitor_text(self.path.read_text())

    def active(self):
        closed = {data["id"] for name, data in self.signals() if name == "NotificationClosed"}
        return [record for identifier, record in self.records.items() if identifier not in closed]

    def send(self, app, summary, body="", actions=()):
        identifier = send(self.tier, app, summary, body, actions)
        assert identifier not in self.records, f"daemon reused {identifier}"
        self.records[identifier] = {"id": identifier, "app": app, "summary": summary,
                                    "body": body, "actions": [label for _, label in actions]}
        return identifier

    def wait_closed(self, identifiers):
        expected = set(identifiers)
        assert raw.poll(lambda: expected <= {
            data["id"] for name, data in self.signals() if name == "NotificationClosed"
        }, 5), self.signals()
        return [data for name, data in self.signals()
                if name == "NotificationClosed" and data["id"] in expected]


@contextmanager
def observing(ctx):
    tier = ctx.tier
    assert tier.env["AGENT_DESKTOP_PRIVATE_SESSION"] == str(tier.runtime_dir)
    connection = raw.connect(tier.bus_address)
    pid = raw.call(connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
                   "org.freedesktop.DBus", "GetConnectionUnixProcessID", "(s)",
                   ("org.freedesktop.Notifications",))[0]
    assert proc.facts(pid)[3].get("XDG_RUNTIME_DIR") == str(tier.runtime_dir), \
        "notification server escaped the private runtime"
    path = Path(tier.runtime_dir) / "notification-signals.log"
    watcher = monitor(tier, path)
    sender = Sender(tier, path)
    try:
        assert raw.poll(lambda: "member=NameLost" in path.read_text(), 5), path.read_text()
        ctx.before("dbus.notifications", sender.active())
        try:
            yield sender
        finally:
            for record in sender.active():
                subprocess.run(["bash", str(_script_path()), "close", str(record["id"])],
                               env=tier.env, capture_output=True, text=True, timeout=10, check=True)
            sender.wait_closed(sender.records)
            assert not sender.active(), sender.active()
            ctx.restored("dbus.notifications", sender.active())
    finally:
        watcher.terminate()
        watcher.wait(timeout=5)
