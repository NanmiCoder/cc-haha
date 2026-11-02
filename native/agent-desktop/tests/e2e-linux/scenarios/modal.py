from oracle import atspi_raw as raw
from runner.helper import changed, managed, ref, require, root
from runner.legs import implementation
from scenarios.menus import _toggle
from scenarios.ref_effects import desktop_restored, menus
from scenarios.surfaces import dialog_state, dismiss_about, open_about


@implementation("modal.calculator_about_blocks_parent")
def calculator_about_blocks_parent(ctx):
    with managed(ctx, "Calculator") as app, desktop_restored(ctx):
        target = ref(ctx, app, name="Main Menu", role="menubutton")
        require(menus(root(ctx, app)) == (), "menu already open")
        open_about(ctx, app)
        before = dialog_state(ctx, app)
        require(len(before) == 1 and before[0][2], f"expected a showing MODAL dialog: {before}")
        changed(lambda: menus(root(ctx, app)), ())
        read = lambda: (dialog_state(ctx, app), menus(root(ctx, app)))
        original = read()
        require(original[1] == (), "opener menu remained visible under the modal")
        ctx.before("atspi.parent_and_modal", original)
        try:
            response = ctx.product(["click", target, "--timeout-ms", "0"])
            error = response.error or {}
            details = error.get("details") or {}
            require(not response.ok and error.get("code") == "ACTION_FAILED", response.raw)
            require(details.get("cause") == "blocked_by_modal_dialog", response.raw)
            require((error.get("disposition") or {}).get("delivery") == "not_delivered", response.raw)
            require(details.get("dialog") == before[0][1], response.raw)
            require(details.get("physical_delivery_started") is False, response.raw)
            ctx.after("atspi.parent_and_modal", changed(read, original))
            ctx.restored("atspi.parent_and_modal", read())
        finally:
            dismiss_about(ctx, app)
        response = ctx.product(["click", target])
        require(response.ok, f"the parent target was unusable after closing the modal: {response.raw}")
        require(raw.poll(lambda: menus(root(ctx, app)), 4), "parent positive control opened no menu")
        _toggle(ctx.tier, app.owner_names[0])
        changed(lambda: menus(root(ctx, app)), ())
