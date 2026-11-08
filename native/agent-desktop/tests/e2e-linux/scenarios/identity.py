from __future__ import annotations

from runner.apps import launch, stop
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import app_root, poll

CALCULATOR = "Calculator"


def window_ids(data) -> list[str]:
    if not data:
        return []
    return [item["id"] for item in data if item.get("id")]


def error_code(envelope) -> str:
    return str((envelope.error or {}).get("code", ""))


def _windows(ctx: LegContext, app: str) -> list[dict]:
    envelope = ctx.product(["list-windows", "--app", app])
    assert envelope.ok, envelope.raw
    return envelope.data or []


def _wait_windows(ctx: LegContext, app: str) -> list[dict]:
    def read():
        envelope = ctx.product(["list-windows", "--app", app])
        return (envelope.data or []) if envelope.ok else []

    return poll(read, 10.0)


def _restarted(ctx: LegContext):
    first = launch(ctx.tier, CALCULATOR)
    original = window_ids(_wait_windows(ctx, CALCULATOR))
    stop(first)
    second = launch(ctx.tier, CALCULATOR)
    replacement = window_ids(_wait_windows(ctx, CALCULATOR))
    return original, replacement, second


@implementation("identity.restart_old_id_window_not_found")
def restart_old_id_window_not_found(ctx: LegContext) -> None:
    original, replacement, second = _restarted(ctx)
    assert original and replacement, f"missing windows: {original!r} {replacement!r}"
    assert original[0] != replacement[0]
    before = len(app_root(ctx.tier, "gnome-calculator").children())
    ctx.before("atspi.root_children", before)
    envelope = ctx.product(["snapshot", "--window-id", original[0], "-i"])
    assert not envelope.ok, envelope.raw
    assert error_code(envelope) == "WINDOW_NOT_FOUND", envelope.raw
    ctx.after("atspi.root_children", len(app_root(ctx.tier, "gnome-calculator").children()))
    ctx.restored("atspi.root_children", len(app_root(ctx.tier, "gnome-calculator").children()))
    stop(second)


@implementation("identity.restart_new_id_resolves")
def restart_new_id_resolves(ctx: LegContext) -> None:
    original, replacement, second = _restarted(ctx)
    assert original and replacement and original[0] != replacement[0]
    ctx.before("atspi.root_children", len(app_root(ctx.tier, "gnome-calculator").children()))
    envelope = ctx.product(["snapshot", "--window-id", replacement[0], "-i"])
    assert envelope.ok, envelope.raw
    assert envelope.data and envelope.data.get("window", {}).get("id") == replacement[0]
    ctx.after("atspi.root_children", len(app_root(ctx.tier, "gnome-calculator").children()))
    ctx.restored("atspi.root_children", len(app_root(ctx.tier, "gnome-calculator").children()))
    stop(second)


@implementation("identity.id_survives_unrelated_launch")
def id_survives_unrelated_launch(ctx: LegContext) -> None:
    calculator = launch(ctx.tier, CALCULATOR)
    original = window_ids(_wait_windows(ctx, CALCULATOR))
    assert original
    read = lambda: len(app_root(ctx.tier, "gnome-calculator").children())
    ctx.before("atspi.root_children", read())
    files = launch(ctx.tier, "Files")
    envelope = ctx.product(["snapshot", "--window-id", original[0], "-i"])
    assert envelope.ok, envelope.raw
    still = window_ids(_windows(ctx, CALCULATOR))
    ctx.after("atspi.root_children", read())
    assert original[0] in still
    stop(files)
    ctx.restored("atspi.root_children", read())
    stop(calculator)
