from __future__ import annotations

import re
import subprocess

from oracle import atspi_raw, x11
from runner.helper import changed
from runner.helper import require
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.headed_actions import assert_ok, live_root
from scenarios.pointer_targets import delivery_target

POINTER_TOLERANCE = 2
FRAME_EXTENTS_RE = re.compile(r"-?\d+")


def assert_error(envelope, codes) -> dict:
    if envelope.ok:
        raise AssertionError(f"{envelope.argv} unexpectedly succeeded")
    error = envelope.error or {}
    if error.get("code") not in codes:
        raise AssertionError(f"{envelope.argv} answered {error.get('code')!r}")
    return error


def parse_frame_extents(text: str) -> tuple[int, int, int, int]:
    values = [int(value) for value in FRAME_EXTENTS_RE.findall(text)]
    if len(values) < 4:
        return (0, 0, 0, 0)
    return (values[0], values[1], values[2], values[3])


def expected_point(
    origin: tuple[int, int],
    frame: tuple[int, int, int, int],
    extents: tuple[int, int, int, int],
) -> tuple[int, int]:
    x, y, width, height = extents
    return (origin[0] + frame[0] + x + width // 2, origin[1] + frame[2] + y + height // 2)


def activation_count(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.strip())


def within(actual: tuple[int, int], expected: tuple[int, int], tolerance: int = POINTER_TOLERANCE) -> bool:
    return abs(actual[0] - expected[0]) <= tolerance and abs(actual[1] - expected[1]) <= tolerance


def delivery_fields(data: dict) -> dict:
    disposition = data.get("disposition") or {}
    delivery = disposition.get("delivery")
    if delivery not in ("delivered_verified", "delivered_unverified", "not_delivered"):
        raise AssertionError(f"delivery report carries {delivery!r}")
    details = data.get("details") or {}
    return {
        "delivery": delivery,
        "retry": disposition.get("retry"),
        "events": details.get("delivered_events"),
        "steps": data.get("steps") or [],
    }


def error_delivery(envelope) -> dict:
    error = envelope.error or {}
    details = error.get("details") or {}
    if error.get("code") == "INVALID_ARGS" and not all(
        isinstance(details.get(key), int) and details[key] > 0
        for key in ("screen_width", "screen_height")
    ):
        raise AssertionError("the refusal did not measure screen dimensions")
    disposition = error.get("disposition") or {}
    delivery = disposition.get("delivery")
    if delivery not in ("not_delivered", "delivered_unverified", "delivered_verified"):
        raise AssertionError(f"error report carries {delivery!r}")
    return {"delivery": delivery, "retry": disposition.get("retry")}


def _xprop(tier, window: str, name: str) -> str:
    process = subprocess.run(
        ["xprop", "-id", x11.xid(tier, window), name],
        capture_output=True,
        text=True,
        env=tier.env,
        timeout=5,
        check=False,
    )
    return process.stdout.strip()


def frame_extents(tier, window: str) -> tuple[int, int, int, int]:
    return parse_frame_extents(_xprop(tier, window, "_GTK_FRAME_EXTENTS"))


def _button_point(ctx: LegContext, target: dict) -> tuple[int, int]:
    root = live_root(ctx.tier, target["app"])
    nodes = [node for node in _flat(root) if node.name == target["button"]]
    if not nodes:
        raise AssertionError(f"{target['name']}: button {target['button']!r} is absent")
    extents = nodes[0].extents(window_coords=True)
    origin = x11.client_origin(ctx.tier, target["window"])
    return expected_point(origin, frame_extents(ctx.tier, target["window"]), extents)


def _flat(node) -> list:
    collected = [node]
    for child in node.children():
        collected.extend(_flat(child))
    return collected


def _extents_at(ctx: LegContext, target: dict, offset: int) -> None:
    window = target["window"]
    geometry = x11.geometry(ctx.tier, window)
    assert_ok(ctx.product(["move-window", "--window-id", window, "--x", str(geometry[0] + offset), "--y", str(geometry[1] + offset)]))
    atspi_raw.poll(lambda: x11.geometry(ctx.tier, window)[0] == geometry[0] + offset, 6.0)
    point = _button_point(ctx, target)
    ctx.before(f"x11.pointer.{target['name']}", x11.pointer(ctx.tier))
    assert_ok(ctx.product(["mouse-move", "--xy", f"{point[0]},{point[1]}"]))
    pointer = x11.pointer(ctx.tier)
    ctx.after(f"x11.pointer.{target['name']}", pointer)
    if not within(pointer, point):
        raise AssertionError(f"{target['name']}: expected point {point}, pointer read {pointer}")


def _refused_argv(verb: str) -> list[str]:
    if verb == "drag":
        return ["drag", "--from-xy=-40,-40", "--to-xy=-30,-30"]
    if verb == "mouse-wheel":
        return ["mouse-wheel", "--x=-40", "--y=-40"]
    return ["mouse-click", "--xy=-40,-40"]


def _restore_pointer(ctx, before, channel="x11.pointer"):
    if x11.pointer(ctx.tier) != before:
        x11.tool(ctx.tier, ["xdotool", "mousemove", str(before[0]), str(before[1])])
    ctx.restored(channel, changed(lambda: x11.pointer(ctx.tier), before))


def _delivery_leg(ctx: LegContext, verb: str) -> None:
    with delivery_target(ctx, verb) as (point, argv, read, restore):
        expected = (point[0] + 90, point[1]) if verb == "drag" else point
        before = x11.pointer(ctx.tier)
        effect_before = read()
        ctx.before("x11.pointer", before)
        ctx.before("atspi.effect", effect_before)
        try:
            data = assert_ok(ctx.product(argv))
            report = delivery_fields(data)
            if report["delivery"] != "delivered_unverified":
                raise AssertionError(f"delivered command reported {report['delivery']}")
            if not report["events"] or not report["steps"]:
                raise AssertionError("delivered command reported no events or no steps")
            pointer = x11.pointer(ctx.tier)
            ctx.after("x11.pointer", pointer)
            if verb != "mouse-wheel" and not within(pointer, expected):
                raise AssertionError(f"pointer {pointer} did not reach {expected}")
            require(atspi_raw.poll(lambda: read() != effect_before, 3),
                    "delivered report has no independent application effect")
            effect_after = read()
            if verb == "mouse-click":
                require(effect_after == "7", "click did not activate the target digit exactly once")
            ctx.after("atspi.effect", effect_after)
            ctx.before("atspi.refused_effect", effect_after)
            refused = ctx.product(_refused_argv(verb))
            assert_error(refused, {"INVALID_ARGS"})
            if error_delivery(refused)["delivery"] != "not_delivered":
                raise AssertionError("an out-of-screen point was not reported as not delivered")
            ctx.after("atspi.refused_effect", read())
            require(read() == effect_after, "not_delivered refusal changed the application")
            ctx.restored("atspi.refused_effect", read())
        finally:
            restore()
            ctx.restored("atspi.effect", changed(read, effect_before))
            _restore_pointer(ctx, before)


@implementation("pointer.drag_delivery_report")
def drag_delivery_report(ctx: LegContext) -> None:
    _delivery_leg(ctx, "drag")


@implementation("pointer.mouse_wheel_delivery_report")
def mouse_wheel_delivery_report(ctx: LegContext) -> None:
    _delivery_leg(ctx, "mouse-wheel")


@implementation("pointer.mouse_click_delivery_report")
def mouse_click_delivery_report(ctx: LegContext) -> None:
    _delivery_leg(ctx, "mouse-click")
