import re

from oracle.atspi_raw import poll
from oracle import x11
from runner.helper import changed, require
from runner.legs import implementation
from scenarios.headed_actions import assert_ok
from scenarios.ref_effects import (LINE, centre, clear_selection, desktop_restored,
                                   editor, menus, policy_refusal, selections)


def selection_effect(field, verb):
    spans = selections(field)
    require(len(spans) == 1, f"{verb} did not produce one selection: {spans}")
    start, end = spans[0]
    text = field.text()[start:end]
    if verb == "double-click":
        require(re.fullmatch(r"[a-z]+", text) is not None and text in LINE.split(),
                f"double-click did not select a word: {text!r}")
    elif verb == "triple-click":
        require(text.rstrip("\n") == LINE, f"triple-click did not select a line: {text!r}")
    else:
        require(end > start and text.strip(), "drag did not select document text")
    return spans


def select_text(ctx, verb):
    with editor(ctx) as (app, tree, field, target), desktop_restored(ctx):
        read = lambda: selections(field)
        before = read()
        ctx.before("atspi.selection", before)
        point = centre(ctx, app, field)
        require(field.extents(window_coords=True)[2] > 180, "document too narrow for drag")
        argv = (["drag", "--from", target, "--to-xy", f"{point[0] + 90},{point[1]}"]
                if verb == "drag" else [verb, target])
        try:
            if ctx.mode == "headless":
                policy_refusal(ctx, argv, read, before)
            else:
                assert_ok(ctx.product(argv))
                require(poll(lambda: bool(read()), 3), "no text selection after gesture")
                selection_effect(field, verb)
        finally:
            ctx.after("atspi.selection", read())
            clear_selection(ctx, app, field)
            ctx.restored("atspi.selection", changed(read, before))


@implementation("ref_actions.double_click")
@implementation("ref_actions.double_click_headless_refusal")
def double_click(ctx):
    select_text(ctx, "double-click")


@implementation("ref_actions.triple_click")
@implementation("ref_actions.triple_click_headless_refusal")
def triple_click(ctx):
    select_text(ctx, "triple-click")


@implementation("ref_actions.drag")
@implementation("ref_actions.drag_headless_refusal")
def drag(ctx):
    select_text(ctx, "drag")


@implementation("ref_actions.right_click")
def right_click(ctx):
    with editor(ctx) as (app, tree, field, target), desktop_restored(ctx):
        before = menus(tree)
        require(not before, "context menu already showing")
        ctx.before("atspi.menu", before)
        try:
            assert_ok(ctx.product(["right-click", target]))
            require(poll(lambda: (33, "Context menu") in menus(tree)
                         and sum(role == 35 for role, _ in menus(tree)) >= 3, 3),
                    "right-click did not expose the raw context menu and its items")
        finally:
            ctx.after("atspi.menu", menus(tree))
            x11.tool(ctx.tier, ["xdotool", "key", "Escape"])
            ctx.restored("atspi.menu", changed(lambda: menus(tree), before))
