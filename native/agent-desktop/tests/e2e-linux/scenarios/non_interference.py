from __future__ import annotations

from oracle import x11
from runner import apps
from runner.helper import activate, changed, display, one
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.headed_actions import assert_ok, live_root, ref_for, window_of


def _semantic_click(ctx: LegContext, app, window: str) -> None:
    before_pointer = x11.pointer(ctx.tier)
    before_active = x11.active_window(ctx.tier)
    tree = live_root(ctx.tier, app)
    before_count = display(tree)
    ctx.before("x11.pointer", before_pointer)
    ctx.before("x11.active_window", before_active)
    ctx.before("atspi.display", before_count)
    assert_ok(ctx.product(["click", ref_for(ctx, window, "7")]))
    try:
        after_count = changed(lambda: display(tree), "7" if before_count in ("", "0") else before_count + "7")
        ctx.after("atspi.display", after_count)
        ctx.after("x11.pointer", x11.pointer(ctx.tier))
        ctx.after("x11.active_window", x11.active_window(ctx.tier))
        if x11.pointer(ctx.tier) != before_pointer or x11.active_window(ctx.tier) != before_active:
            raise AssertionError("a semantic click changed pointer or focus")
    finally:
        activate(one(tree, role=43, name="Undo"))
        ctx.restored("atspi.display", changed(lambda: display(tree), before_count))
        ctx.restored("x11.pointer", x11.pointer(ctx.tier))
        ctx.restored("x11.active_window", x11.active_window(ctx.tier))


@implementation("non_interference.active_window_unchanged_by_semantic_click")
def active_window_unchanged_by_semantic_click(ctx: LegContext) -> None:
    app = apps.launch(ctx.tier, "Calculator")
    other = apps.launch(ctx.tier, "Text Editor")
    try:
        active = x11.active_window(ctx.tier)
        _semantic_click(ctx, app, window_of(app))
        if x11.active_window(ctx.tier) != active:
            raise AssertionError("a headless semantic click changed the active window")
    finally:
        apps.stop(other)
        apps.stop(app)
