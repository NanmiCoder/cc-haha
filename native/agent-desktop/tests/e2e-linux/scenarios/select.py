from oracle import gsettings
from runner.helper import changed, command, managed, one, ref, require, root
from runner.legs import implementation
from runner.verdict import LegContext


def select_contract(ctx, *, absent=False):
    schema, key = "org.gnome.desktop.session", "idle-delay"
    initial = gsettings.get(ctx.tier, schema, key)
    with managed(ctx, "Settings", ("power",)) as app:
        tree = root(ctx, app)
        combos = tree.find(role=11)
        candidates = [node for node in combos if "Screen Blank" in node.name]
        require(len(candidates) == 1, "Screen Blank combo missing or ambiguous")
        combo = candidates[0]
        target = ref(ctx, app, role="combobox", name=combo.name)
        ctx.before("gsettings", initial)
        try:
            response = command(ctx, ["select", target, "Never" if not absent else "absent-option"],
                               app, code="ACTION_NOT_SUPPORTED")
            require("Select" in response.error["message"] or "semantic" in response.error["message"],
                    response.raw)
            changed(lambda: gsettings.get(ctx.tier, schema, key), initial, floor=0.3)
            ctx.after("gsettings", gsettings.get(ctx.tier, schema, key))
        finally:
            require(gsettings.get(ctx.tier, schema, key) == initial)
            ctx.restored("gsettings", gsettings.get(ctx.tier, schema, key))


@implementation("select.screen_blank_value")
def screen_blank_value(ctx: LegContext) -> None:
    select_contract(ctx)


@implementation("select.refusal_without_semantic_route")
def refusal_without_semantic_route(ctx: LegContext) -> None:
    select_contract(ctx, absent=True)
