from oracle import x11
from oracle.gsettings import tool
from runner.helper import changed, managed, require
from runner.legs import REGISTRY, implementation
from scenarios import lifecycle, toolkit_qt


def geometry_operation(ctx, operation):
    with managed(ctx, "Calculator") as app:
        window = app.windows[0]
        read = lambda: lifecycle._geometry(ctx, window)
        before = read()
        ctx.before("x11.geometry", before)
        if operation == "move-window":
            expected = (before[0] + 30, before[1] + 30, *before[2:])
            args = ["--x", str(expected[0]), "--y", str(expected[1])]
        else:
            expected = (*before[:2], before[2] + 40, before[3] + 30)
            args = ["--width", str(expected[2]), "--height", str(expected[3])]
        try:
            response = ctx.product([operation, "--window-id", window, *args])
            after = changed(read, expected, seconds=6)
            ctx.after("x11.geometry", after)
            require(response.ok, response.raw)
            delivery = lifecycle.delivery_fields(response.data)
            require(delivery["delivery"] != "not_delivered", "observed effect reported undelivered")
        finally:
            lifecycle._restore_geometry(ctx, window, before)


@implementation("gaps.mutter_move")
def mutter_move(ctx):
    geometry_operation(ctx, "move-window")


@implementation("gaps.mutter_resize")
def mutter_resize(ctx):
    geometry_operation(ctx, "resize-window")


def maximized_state(ctx, window):
    states = lifecycle.parse_wm_state(lifecycle._wm_state(ctx.tier, window).replace(",", " "))
    return {"_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ"} <= states


def minimize_restore(ctx):
    with managed(ctx, "Calculator") as app:
        window = app.windows[0]
        read = lambda: lifecycle.is_hidden(lifecycle._wm_state(ctx.tier, window))
        before = read()
        require(before is False, "window must start restored")
        ctx.before("x11.window_state", before)
        try:
            response = ctx.product(["minimize", "--window-id", window])
            ctx.after("x11.window_state", changed(read, True, seconds=6))
            require(response.ok, response.raw)
            require(lifecycle.delivery_fields(response.data)["delivery"] != "not_delivered")
            response = ctx.product(["restore", "--window-id", window])
            require(response.ok, response.raw)
            ctx.restored("x11.window_state", changed(read, before, seconds=6))
        finally:
            if read() != before:
                native = x11.xid(ctx.tier, window)
                tool(ctx.tier, ["wmctrl", "-ir", native, "-b", "remove,maximized_vert,maximized_horz"])
                tool(ctx.tier, ["xdotool", "windowmap", native])


@implementation("gaps.mutter_minimize_restore")
def mutter_minimize_restore(ctx):
    minimize_restore(ctx)


@implementation("gaps.mutter_window_operation_refusals")
def mutter_window_operation_refusals(ctx):
    with managed(ctx, "Calculator") as app:
        window = app.windows[0]
        read = lambda: (lifecycle._geometry(ctx, window), lifecycle._wm_state(ctx.tier, window))
        before = read()
        ctx.before("x11.window", before)
        for verb, args in (("move-window", ["--x", "20", "--y", "20"]),
                           ("resize-window", ["--width", "400", "--height", "500"]),
                           ("minimize", [])):
            response = ctx.product([verb, "--window-id", "w-missing", *args])
            require(not response.ok and (response.error or {}).get("code") == "WINDOW_NOT_FOUND", response.raw)
            require(lifecycle.error_delivery(response)["delivery"] == "not_delivered", response.raw)
            require(read() == before, "missing-window operation changed the real window")
        ctx.after("x11.window", read())
        ctx.restored("x11.window", read())


for _suffix in ("headless_click_logged_once", "headed_click_logged_once", "scroll_refused_no_container",
                "wait_menu_opens", "wait_menu_closes", "menu_already_open"):
    if "gaps.mutter_qt_" + _suffix in {leg.id for leg in REGISTRY}:
        implementation("gaps.mutter_qt_" + _suffix)(getattr(toolkit_qt, _suffix))
