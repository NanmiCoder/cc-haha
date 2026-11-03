from __future__ import annotations

import re
import time
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Callable

from runner.session import Tier


ACCESSIBLE = "org.a11y.atspi.Accessible"
ROOT = "/org/a11y/atspi/accessible/root"
_DEADLINE = ContextVar("oracle_deadline", default=None)
STATE_BITS = {
    1: "ACTIVE", 4: "CHECKED", 5: "COLLAPSED", 6: "DEFUNCT", 8: "ENABLED",
    9: "EXPANDABLE", 10: "EXPANDED", 11: "FOCUSABLE", 12: "FOCUSED",
    14: "HORIZONTAL", 16: "MODAL", 20: "PRESSED", 22: "SELECTABLE",
    23: "SELECTED", 24: "SENSITIVE", 25: "SHOWING", 29: "VERTICAL",
    30: "VISIBLE", 31: "MANAGES_DESCENDANTS", 41: "CHECKABLE",
}


def decode_states(words: list[int]) -> frozenset[str]:
    return frozenset(name for bit, name in STATE_BITS.items()
                     if bit // 32 < len(words) and words[bit // 32] & (1 << (bit % 32)))


@contextmanager
def bounded_until(deadline):
    token = _DEADLINE.set(deadline)
    try:
        yield
    finally:
        _DEADLINE.reset(token)


def remaining_timeout(seconds):
    deadline = _DEADLINE.get()
    remaining = seconds if deadline is None else min(seconds, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError("oracle responsiveness deadline expired")
    return remaining


def connect(address: str):
    from gi.repository import Gio
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
    flags |= Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    cancellable = Gio.Cancellable.new()
    timer = threading.Timer(remaining_timeout(1.5), cancellable.cancel)
    timer.daemon = True
    timer.start()
    try:
        return Gio.DBusConnection.new_for_address_sync(address, flags, None, cancellable)
    finally:
        timer.cancel()


def call(connection, bus, path, interface, method, signature="()", args=()):
    from gi.repository import Gio, GLib
    return connection.call_sync(
        bus, path, interface, method, GLib.Variant(signature, args), None,
        Gio.DBusCallFlags.NONE, max(1, int(remaining_timeout(1.5) * 1000)), None,
    ).unpack()


class RawNode:
    def __init__(self, connection, bus: str, path: str):
        self.connection = connection
        self.bus = bus
        self.path = path

    def invoke(self, interface, method, signature="()", args=()):
        return call(self.connection, self.bus, self.path, interface, method, signature, args)

    def get_property(self, interface: str, name: str):
        return self.invoke("org.freedesktop.DBus.Properties", "Get", "(ss)",
                           (interface, name))[0]

    @property
    def role(self) -> int:
        return self.invoke(ACCESSIBLE, "GetRole")[0]

    @property
    def name(self) -> str:
        return self.get_property(ACCESSIBLE, "Name")

    @property
    def states(self) -> frozenset[str]:
        return decode_states(self.invoke(ACCESSIBLE, "GetState")[0])

    def interfaces(self) -> list[str]:
        return self.invoke(ACCESSIBLE, "GetInterfaces")[0]

    def attributes(self) -> dict:
        return self.invoke(ACCESSIBLE, "GetAttributes")[0]

    def children(self) -> list["RawNode"]:
        return [RawNode(self.connection, bus or self.bus, path)
                for bus, path in self.invoke(ACCESSIBLE, "GetChildren")[0]
                if path != "/org/a11y/atspi/null"]

    def walk(self) -> list["RawNode"]:
        pending, result, seen = [self], [], set()
        deadline = time.monotonic() + 15
        while pending:
            if len(result) >= 10000 or time.monotonic() >= deadline:
                raise TimeoutError("raw accessibility walk exceeded its budget")
            node = pending.pop()
            key = node.bus, node.path
            if key in seen:
                continue
            seen.add(key)
            result.append(node)
            pending.extend(reversed(node.children()))
        return result

    def find(self, *, role: int | None = None, name: str | None = None) -> list["RawNode"]:
        return [node for node in self.walk()
                if (role is None or node.role == role) and (name is None or node.name == name)]

    def extents(self, window_coords: bool = False) -> tuple[int, int, int, int]:
        return tuple(self.invoke("org.a11y.atspi.Component", "GetExtents", "(u)",
                                 (1 if window_coords else 0,))[0])

    def text(self) -> str | None:
        if "org.a11y.atspi.Text" not in self.interfaces():
            return None
        count = self.get_property("org.a11y.atspi.Text", "CharacterCount")
        return self.invoke("org.a11y.atspi.Text", "GetText", "(ii)", (0, count))[0]

    def value(self) -> float | None:
        if "org.a11y.atspi.Value" not in self.interfaces():
            return None
        return float(self.get_property("org.a11y.atspi.Value", "CurrentValue"))

    def do_action(self, name: str) -> bool:
        count = self.get_property("org.a11y.atspi.Action", "NActions")
        for index in range(count):
            actual = self.invoke("org.a11y.atspi.Action", "GetName", "(i)", (index,))[0]
            if actual.casefold() == name.casefold():
                return self.invoke("org.a11y.atspi.Action", "DoAction", "(i)", (index,))[0]
        return False


def registry(tier: Tier) -> list[RawNode]:
    connection = connect(tier.a11y_bus_address)
    return RawNode(connection, "org.a11y.atspi.Registry", ROOT).children()


def owner_pid(node: RawNode) -> int:
    return call(node.connection, "org.freedesktop.DBus", "/org/freedesktop/DBus",
                "org.freedesktop.DBus", "GetConnectionUnixProcessID", "(s)", (node.bus,))[0]


def app_root(tier: Tier, owner_name: str) -> RawNode:
    from oracle.proc import facts, may_match
    if re.fullmatch(r":\d+\.\d+", owner_name):
        node = RawNode(connect(tier.a11y_bus_address), owner_name, ROOT)
        if facts(owner_pid(node))[3].get("XDG_RUNTIME_DIR") != str(tier.runtime_dir):
            raise LookupError(f"owner {owner_name!r} is not private")
        return node
    matches = []
    for node in registry(tier):
        process_name = ""
        pid = None
        try:
            pid = owner_pid(node)
            _, _, process_name, env = facts(pid)
            if env.get("XDG_RUNTIME_DIR") == str(tier.runtime_dir) and node.name == owner_name:
                matches.append(node)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        except Exception as error:
            if "org.freedesktop.DBus.Error.NameHasNoOwner" in str(error):
                continue
            if pid is None or may_match(pid, process_name, (owner_name,)):
                raise
            if not unresponsive(error) and "NameHasNoOwner" not in str(error):
                raise
    matches = [node for node in matches
               if facts(owner_pid(node))[3].get("XDG_RUNTIME_DIR") == str(tier.runtime_dir)]
    if len(matches) != 1:
        raise LookupError(f"expected one private owner {owner_name!r}, found {len(matches)}")
    return matches[0]


def unresponsive(error) -> bool:
    return isinstance(error, TimeoutError) or any(token in str(error) for token in
        ("org.freedesktop.DBus.Error.NoReply", "Timeout was reached", "g-io-error-quark: Timeout"))


def poll(predicate: Callable[[], object], deadline_s: float, *, floor_s: float = 0.0):
    if deadline_s < 0 or floor_s < 0 or floor_s > deadline_s:
        raise ValueError("invalid poll budget")
    started = time.monotonic()
    while True:
        value = predicate()
        elapsed = time.monotonic() - started
        if (value and elapsed >= floor_s) or elapsed >= deadline_s:
            return value
        time.sleep(min(0.05, deadline_s - elapsed))
