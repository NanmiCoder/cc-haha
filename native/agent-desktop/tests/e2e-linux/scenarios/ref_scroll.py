from oracle.atspi_raw import poll
from runner.helper import changed, command, managed, nodes, one, ref, require, root, snapshot
from runner.legs import implementation
from scenarios.headed_actions import assert_ok
from scenarios.ref_effects import desktop_restored, policy_refusal
from scenarios.scroll import raw_value


def content_bar(tree):
    bars = [node for node in tree.find(role=48) if node.value() is not None
            and "VERTICAL" in node.states]
    require(bars, "no Settings scrollbar")
    return max(bars, key=lambda node: node.extents(window_coords=True)[0])


def inside(control, viewport):
    _, y, _, height = control.extents(window_coords=True)
    return y >= viewport[1] and y + height <= viewport[1] + viewport[3]


@implementation("ref_actions.scroll")
@implementation("ref_actions.scroll_headless_refusal")
def scroll(ctx):
    with managed(ctx, "Settings", ("multitasking",)) as app, desktop_restored(ctx):
        tree = root(ctx, app)
        bar = content_bar(tree)
        upper = one(tree, role=7, name="Hot Corner")
        lower = one(tree, role=7, name="Dynamic Workspaces")
        viewport = bar.extents(window_coords=True)
        initial = bar.value()
        read = lambda: (bar.value(), tuple((node.extents(window_coords=True), "CHECKED" in node.states)
                                         for node in (upper, lower)))
        before = read()
        require(inside(upper, viewport) and not inside(lower, viewport), "wrong initial visible rows")
        data = snapshot(ctx, app)
        candidates = [item["ref_id"] for item in nodes(data.get("tree"))
                      if item.get("ref_id") and item.get("role") == "scrollarea"
                      and any(child.get("name") == "Hot Corner" for child in nodes(item))]
        require(len(candidates) == 1, "no unique scrollable Settings content ref")
        target = candidates[0]
        ctx.before("atspi.viewport", before)
        try:
            argv = ["scroll", target, "--direction", "down", "--amount", "3"]
            if ctx.mode == "headless":
                policy_refusal(ctx, argv, read, before)
            else:
                assert_ok(ctx.product(argv))
                require(poll(lambda: bar.value() > initial and not inside(upper, viewport)
                             and inside(lower, viewport), 3), "scroll did not change visible rows")
            ctx.after("atspi.viewport", read())
        finally:
            raw_value(bar, initial)
            ctx.restored("atspi.viewport", changed(read, before))


@implementation("ref_actions.scroll_to")
def scroll_to(ctx):
    with managed(ctx, "Settings", ("multitasking",)) as app, desktop_restored(ctx):
        tree = root(ctx, app)
        label = "Include apps from each monitor only"
        control = one(tree, role=7, name=label)
        bar = content_bar(tree)
        target = ref(ctx, app, name=label, role="checkbox")
        viewport = bar.extents(window_coords=True)
        def read():
            return bar.value(), control.extents(window_coords=True), "CHECKED" in control.states
        visible = lambda: inside(control, viewport)
        before = read()
        require(not visible(), "scroll-to control must start beyond the viewport")
        ctx.before("atspi.viewport", before)
        try:
            command(ctx, ["scroll-to", target], app)
            require(poll(visible, 3), "scroll-to did not reveal its control")
            after = read()
            require(after[0] != before[0] and after[2] == before[2],
                    "scroll-to did not scroll or changed the setting")
            ctx.after("atspi.viewport", after)
        finally:
            raw_value(bar, before[0])
            ctx.restored("atspi.viewport", changed(read, before))
