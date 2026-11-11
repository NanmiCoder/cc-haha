from runner.helper import (command, managed, nodes, one, ref, require, root,
                           snapshot)
from runner.legs import implementation
from runner.verdict import LegContext


def zero_axis(bounds):
    return bounds[2] == 0 or bounds[3] == 0


def geometry_only(ctx, name, args):
    with managed(ctx, name, args) as app:
        tree = root(ctx, app)
        raw_nodes = [node for node in tree.walk()
                     if "org.a11y.atspi.Component" in node.interfaces()]
        empty = [(node.path, node.role, node.extents()) for node in raw_nodes
                 if zero_axis(node.extents())]
        require(empty, "no zero-axis raw container reached")
        ctx.before("atspi", empty)
        data = snapshot(ctx, app, "--include-bounds")
        for node in nodes(data.get("tree")):
            bounds = node.get("bounds")
            if bounds and (bounds["width"] <= 0 or bounds["height"] <= 0):
                require(not node.get("ref_id"), "zero-size container received a ref")
        after = [(node.path, node.role, node.extents()) for node in raw_nodes
                 if zero_axis(node.extents())]
        require(empty == after)
        ctx.after("atspi", after)
        ctx.restored("atspi", [(node.path, node.role, node.extents()) for node in raw_nodes
                               if zero_axis(node.extents())])


@implementation("zero_bounds.files_container_raw_only")
def files_container_raw_only(ctx: LegContext) -> None:
    geometry_only(ctx, "Files", (str(ctx.tier.runtime_dir),))


@implementation("zero_bounds.settings_container_raw_only")
def settings_container_raw_only(ctx: LegContext) -> None:
    geometry_only(ctx, "Settings", ("multitasking",))


@implementation("zero_bounds.hidden_menu_items_not_visible")
def hidden_menu_items_not_visible(ctx: LegContext) -> None:
    with managed(ctx, "Terminal", ("--hide-menubar",)) as app:
        tree = root(ctx, app)
        item = one(tree, role=33, name="Edit")
        require("SHOWING" not in item.states)
        ctx.before("atspi", sorted(item.states))
        target = ref(ctx, app, name="Edit", role="menu")
        response = command(ctx, ["is", target, "--property", "visible"], app)
        require(response.data["result"] is False)
        command(ctx, ["click", target, "--timeout-ms", "0"], app, code="ACTION_FAILED")
        require("SHOWING" not in item.states)
        ctx.after("atspi", sorted(item.states))
        ctx.restored("atspi", sorted(item.states))
