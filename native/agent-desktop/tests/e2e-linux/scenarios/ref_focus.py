from oracle import x11
from oracle.atspi_raw import poll
from runner.helper import changed, managed, one, ref, require, root
from runner.legs import implementation
from scenarios.headed_actions import assert_ok
from scenarios.ref_effects import desktop_restored, policy_refusal


def grab(node):
    require(node.invoke("org.a11y.atspi.Component", "GrabFocus")[0], "raw focus failed")
    changed(lambda: "FOCUSED" in node.states, True)


@implementation("ref_actions.focus")
@implementation("ref_actions.focus_headless_refusal")
def focus(ctx):
    with managed(ctx, "Qt") as app:
        tree = root(ctx, app)
        target = ref(ctx, app, name="Text entry", role="textfield")
        field = one(tree, name="Text entry")
        other = one(tree, role=43, name="Press me")
        grab(other)
        read = lambda: ("FOCUSED" in field.states, "FOCUSED" in other.states)
        before = changed(read, (False, True))
        with desktop_restored(ctx):
            ctx.before("atspi.focus", before)
            try:
                if ctx.mode == "headless":
                    policy_refusal(ctx, ["focus", target], read, before)
                else:
                    assert_ok(ctx.product(["focus", target]))
                    changed(read, (True, False))
                ctx.after("atspi.focus", read())
            finally:
                grab(other)
                ctx.restored("atspi.focus", changed(read, before))


def hover_status(tree):
    return tuple(sorted(node.name for node in tree.walk()
                        if node.name == "Pointer over the button" and "SHOWING" in node.states))


@implementation("ref_actions.hover")
@implementation("ref_actions.hover_headless_refusal")
def hover(ctx):
    with managed(ctx, "Qt") as app:
        tree = root(ctx, app)
        target = ref(ctx, app, name="Press me", role="button")
        with desktop_restored(ctx):
            before = hover_status(tree)
            require(not before, "hover status already showing")
            ctx.before("atspi.hover_status", before)
            try:
                if ctx.mode == "headless":
                    policy_refusal(ctx, ["hover", target], lambda: hover_status(tree), before)
                else:
                    assert_ok(ctx.product(["hover", target]))
                    require(poll(lambda: hover_status(tree), 4), "hover exposed no raw status text")
                ctx.after("atspi.hover_status", hover_status(tree))
            finally:
                if ctx.mode == "headed":
                    x11.tool(ctx.tier, ["xdotool", "mousemove", "1", "1"])
                ctx.restored("atspi.hover_status", changed(lambda: hover_status(tree), before))
