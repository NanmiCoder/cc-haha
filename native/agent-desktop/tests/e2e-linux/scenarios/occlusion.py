import json

from oracle import atspi_raw, x11
from runner import apps
from runner.helper import activate, changed, display, one, ref, require, root
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.headed_actions import assert_ok, window_of
from scenarios.lifecycle import _wm_state, parse_wm_state
from scenarios.pointer import expected_point, frame_extents


def _document_node(ctx, app):
    return one(root(ctx, app), role=61)


def _document(ctx, app):
    field = _document_node(ctx, app)
    return field.text(), field.get_property("org.a11y.atspi.Text", "CaretOffset")


def _cover_display(ctx, cover):
    return display(root(ctx, cover))


def _target_ref(ctx, app):
    return ref(ctx, app, role="textfield")


def _above_state(ctx, cover):
    return "_NET_WM_STATE_ABOVE" in parse_wm_state(_wm_state(ctx.tier, window_of(cover)))


def _write_document(ctx, app, text):
    field = _document_node(ctx, app)
    require(field.invoke("org.a11y.atspi.EditableText", "SetTextContents", "(s)", (text,))[0])
    changed(field.text, text)


def _restore_document(ctx, app, initial):
    _write_document(ctx, app, "")
    _write_document(ctx, app, initial[0])
    return changed(lambda: _document(ctx, app), initial)


def _visible_geometry(tier, window):
    x, y, width, height = x11.geometry(tier, window)
    left, right, top, bottom = frame_extents(tier, window)
    require(min(left, right, top, bottom) >= 0 and width > left + right and height > top + bottom,
            "the client shadow does not leave a visible cover")
    return x + left, y + top, width - left - right, height - top - bottom


def _setup(ctx):
    target = apps.launch(ctx.tier, "Text Editor")
    window = window_of(target)
    _write_document(ctx, target, "\n".join(f"occlusion line {i:02d} baseline text" for i in range(40)))
    field = _document_node(ctx, target)
    point = expected_point(x11.client_origin(ctx.tier, window), frame_extents(ctx.tier, window),
                           field.extents(window_coords=True))
    cover = apps.launch(ctx.tier, "Calculator")
    x, y, width, height = x11.geometry(ctx.tier, window)
    assert_ok(ctx.product(["resize-window", "--window-id", window_of(cover),
                           "--width", str(width + 40), "--height", str(height + 40)]))
    assert_ok(ctx.product(["move-window", "--window-id", window_of(cover),
                           "--x", str(x), "--y", str(y)]))
    changed(lambda: _visible_geometry(ctx.tier, window_of(cover))[:2], (x, y), seconds=6)
    cx, cy, cw, ch = _visible_geometry(ctx.tier, window_of(cover))
    require(cx <= point[0] < cx + cw and cy <= point[1] < cy + ch,
            "the cover does not cover the document's measured point")
    return target, window, cover


def _occlusion(ctx, *, above=False, drop=False, refuse=False):
    target, window, cover = _setup(ctx)
    initial = _document(ctx, target)
    initial_cover = _cover_display(ctx, cover)
    initial_above = _above_state(ctx, cover)
    ctx.before("atspi.document", initial)
    ctx.before("atspi.cover_display", initial_cover)
    ctx.before("x11.cover_above", initial_above)
    before_stack = None
    try:
        if above:
            x11.set_above(ctx.tier, window_of(cover), True)
            changed(lambda: _above_state(ctx, cover), True)
        if drop:
            x11.set_above(ctx.tier, window_of(cover), False)
            changed(lambda: _above_state(ctx, cover), False)
        ctx.after("x11.cover_above", _above_state(ctx, cover))
        before_stack = x11.stacking(ctx.tier)
        require(window in before_stack and window_of(cover) in before_stack
                and before_stack.index(window_of(cover)) > before_stack.index(window),
                "the cover is not above the target before dispatch")
        ctx.before("x11.stacking", before_stack)
        response = ctx.product(["click", _target_ref(ctx, target)])
        if refuse:
            error = response.error or {}
            require(not response.ok and error.get("code") in ("ACTION_FAILED", "TIMEOUT")
                    and "occlud" in json.dumps(error).lower()
                    and (error.get("disposition") or {}).get("delivery") == "not_delivered",
                    "the above-layer cover did not refuse the pointer click")
            require(_document(ctx, target) == initial, "a refused click changed the editor document or caret")
        else:
            assert_ok(response)
            require(atspi_raw.poll(lambda: _document(ctx, target)[1] != initial[1], 6),
                    "the pointer click did not move the editor caret")
            require(_document(ctx, target)[0] == initial[0], "a click changed document text")
        ctx.after("atspi.document", _document(ctx, target))
        ctx.after("atspi.cover_display", _cover_display(ctx, cover))
        require(_cover_display(ctx, cover) == initial_cover, "the covering Calculator received input")
        ctx.after("x11.stacking", x11.stacking(ctx.tier))
    finally:
        ctx.restored("atspi.document", _restore_document(ctx, target, initial))
        ctx.restored("atspi.cover_display", _cover_display(ctx, cover))
        x11.set_above(ctx.tier, window_of(cover), initial_above)
        ctx.restored("x11.cover_above", changed(lambda: _above_state(ctx, cover), initial_above))
        if before_stack is not None:
            if x11.stacking(ctx.tier) != before_stack:
                x11.restore_active(ctx.tier, x11.xid(ctx.tier, window_of(cover)))
            ctx.restored("x11.stacking", changed(lambda: x11.stacking(ctx.tier), before_stack))
        apps.stop(cover)
        apps.stop(target)


@implementation("occlusion.ordinary_cover_removed_click_lands")
def ordinary_cover_removed_click_lands(ctx: LegContext) -> None:
    _occlusion(ctx)


@implementation("occlusion.above_cover_refused_no_effect")
def above_cover_refused_no_effect(ctx: LegContext) -> None:
    _occlusion(ctx, above=True, refuse=True)


@implementation("occlusion.above_flag_dropped_click_lands")
def above_flag_dropped_click_lands(ctx: LegContext) -> None:
    _occlusion(ctx, above=True, drop=True)
