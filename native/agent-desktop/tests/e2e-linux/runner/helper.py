from __future__ import annotations

import contextlib
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Callable

from oracle import atspi_raw as raw, x11
from runner import apps


class Trigger:
    def __init__(self, delay_s: float, action: Callable[[], None]):
        if delay_s < 0:
            raise ValueError("negative delay")
        self.fired_at = None
        self.error = None
        self.cancelled = threading.Event()

        def fire():
            if self.cancelled.wait(delay_s):
                return
            self.fired_at = time.monotonic()
            try:
                action()
            except BaseException as error:
                self.error = error

        self.thread = threading.Thread(target=fire, daemon=True)
        self.thread.start()

    def join(self) -> None:
        self.thread.join(10)
        if self.thread.is_alive():
            raise TimeoutError("delayed trigger did not complete")
        if self.error:
            raise self.error

    def cancel(self):
        self.cancelled.set()
        self.join()


def delayed(delay_s: float, action: Callable[[], None]) -> Trigger:
    return Trigger(delay_s, action)


def require(condition, message="independent observation disagrees"):
    if not condition:
        raise AssertionError(message)


def nodes(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            if isinstance(item, (dict, list)):
                yield from nodes(item)
    elif isinstance(value, list):
        for item in value:
            yield from nodes(item)


def command(ctx, argv, app=None, *, code=None, **kw):
    quiet = (ctx.mode == "headless" and not kw.get("headed", False)
             and ctx.tier.display and argv[0] != "focus-window")
    before = (x11.pointer(ctx.tier), x11.active_window(ctx.tier)) if quiet else None
    operation = argv[2] if argv[0] == "--session" else argv[0]
    if app is not None and operation in ("snapshot", "find", "press"):
        kw.setdefault("window_id", app.windows[0])
    response = ctx.product(argv, **kw)
    if quiet:
        after = x11.pointer(ctx.tier), x11.active_window(ctx.tier)
        require(before == after, f"headless command moved pointer or focus: {argv}")
    error = (response.error or {}).get("code")
    if error == "PLATFORM_NOT_SUPPORTED":
        raise NotImplementedError(f"product feature missing: {argv}")
    if code is None:
        require(response.ok, f"{argv}: {response.raw}")
    else:
        allowed = (code,) if isinstance(code, str) else code
        require(not response.ok and error in allowed, f"expected {allowed}: {response.raw}")
    return response


def snapshot(ctx, app, *extra):
    data = command(ctx, ["snapshot", "-i", *extra], app).data
    require(data and data.get("complete") is True, "incomplete snapshot")
    return data


def ref(ctx, app, *, role=None, name=None, surface=None):
    args = ["find", "--exact", "--limit", "0"]
    for key, value in (("role", role), ("name", name), ("surface", surface)):
        if value is not None:
            args.extend(["--" + key, value])
    data = command(ctx, args, app).data
    found = {item["ref_id"] for item in nodes(data) if isinstance(item.get("ref_id"), str)}
    require(len(found) == 1, f"expected one qualified ref for {role}/{name}, found {found}")
    result = found.pop()
    require(re.fullmatch(r"@[^:]+:e[0-9]+", result), "unqualified ref")
    return result


def root(ctx, app):
    return raw.app_root(ctx.tier, app.owner_names[0])


def one(node, *, role=None, name=None):
    matches = node.find(role=role, name=name)
    require(len(matches) == 1, f"expected one raw node for {role}/{name}: {len(matches)}")
    return matches[0]


def changed(read, expected, *, seconds=3, floor=0):
    require(raw.poll(lambda: read() == expected, seconds, floor_s=floor),
            f"oracle never reached {expected!r}; final={read()!r}")
    return read()


def display(node):
    fields = [item.text() for item in node.find(role=61) if item.text() is not None]
    require(fields, "Calculator display missing")
    return fields[0]


def activate(node):
    require(node.do_action("click") or node.do_action("activate") or node.do_action("press"),
            "raw activation unavailable")


@contextlib.contextmanager
def managed(ctx, name, args=()):
    app = apps.launch_qt(ctx.tier) if name == "Qt" else apps.launch(ctx.tier, name, args)
    try:
        yield app
    finally:
        apps.stop(app)


def remove(path: Path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)
    require(not path.exists(), "cleanup did not remove the artifact")


def stale_twin(ctx, app, target, read, action=("click",)):
    before = read()
    snapshot_id = target.split(":", 1)[0]
    absent = snapshot_id + ":e999999"
    command(ctx, [action[0], absent, *action[1:], "--timeout-ms", "0"], app,
            code=("ELEMENT_NOT_FOUND", "STALE_REF"))
    require(read() == before, "absent-target action changed the oracle")
