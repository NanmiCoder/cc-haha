from contextlib import contextmanager

from oracle import atspi_raw as raw, x11
from oracle.gsettings import tool
from runner.helper import activate, changed, display, managed, one, require, root
from runner.legs import implementation
from scenarios import lifecycle, toolkit_qt
from scenarios.pointer import expected_point, frame_extents


@contextmanager
def target_app(ctx, toolkit):
    if toolkit == "qt":
        with toolkit_qt.qt_app(ctx) as app:
            yield app
    else:
        with managed(ctx, "Calculator") as app:
            yield app


def gesture(ctx, toolkit, position):
    with target_app(ctx, toolkit) as app:
        window = app.windows[0]
        tree = root(ctx, app)
        target = one(tree, role=43, name="7" if toolkit == "gtk4" else "Press me")
        geometry = lifecycle._geometry(ctx, window)
        pointer, active = x11.pointer(ctx.tier), x11.active_window(ctx.tier)
        ctx.before("x11.pointer", pointer)
        ctx.before("x11.geometry", geometry)
        ctx.before("x11.active_window", active)
        ctx.before("atspi.target_geometry", (target.extents(window_coords=True),
                                              x11.client_origin(ctx.tier, window)))
        try:
            if position == "second":
                destination = (80, 90) if geometry[:2] != (80, 90) else (120, 130)
                tool(ctx.tier, ["wmctrl", "-ir", x11.xid(ctx.tier, window), "-e",
                               f"0,{destination[0]},{destination[1]},-1,-1"])
                require(raw.poll(lambda: lifecycle._geometry(ctx, window)[:2] == destination, 6))
            extents = target.extents(window_coords=True)
            origin = x11.client_origin(ctx.tier, window)
            point = expected_point(origin, frame_extents(ctx.tier, window), extents)
            require(min(extents[2:]) > 0, "gesture target has no positive geometry")
            before = display(tree) if toolkit == "gtk4" else None
            if toolkit == "qt":
                log = ctx.tier.runtime_dir / "qt-window.log"
                initial_log = toolkit_qt.events(log)
                before = initial_log.count("click")
                read = lambda: toolkit_qt.events(log).count("click")
            else:
                read = lambda: display(tree)
            if toolkit != "qt":
                ctx.before("atspi.effect", before)
            response = ctx.product(["mouse-click", "--xy", f"{point[0]},{point[1]}"])
            require(response.ok, response.raw)
            ctx.after("x11.pointer", changed(lambda: x11.pointer(ctx.tier), point))
            ctx.after("x11.geometry", lifecycle._geometry(ctx, window))
            ctx.after("x11.active_window", x11.active_window(ctx.tier))
            ctx.after("atspi.target_geometry", (target.extents(window_coords=True), x11.client_origin(ctx.tier, window)))
            expected = before + 1 if toolkit == "qt" else (
                "7" if before in ("", "0") else before + "7")
            observed = changed(read, expected)
            if toolkit == "qt":
                ctx.after("applog", toolkit_qt.log_state(ctx))
            else:
                ctx.after("atspi.effect", observed)
            if toolkit == "gtk4":
                activate(one(tree, role=43, name="Undo"))
            if toolkit != "qt":
                ctx.restored("atspi.effect", changed(read, before))
        finally:
            if position == "second":
                lifecycle._restore_geometry(ctx, window, geometry)
            else:
                ctx.restored("x11.geometry", lifecycle._geometry(ctx, window))
            ctx.restored("atspi.target_geometry", (target.extents(window_coords=True),
                                                    x11.client_origin(ctx.tier, window)))
            tool(ctx.tier, ["xdotool", "mousemove", str(pointer[0]), str(pointer[1])])
            ctx.restored("x11.pointer", changed(lambda: x11.pointer(ctx.tier), pointer))
            ctx.restored("x11.active_window", x11.restore_active(ctx.tier, active))


for _toolkit in ("gtk4", "qt"):
    for _position in (("first", "second") if _toolkit == "gtk4" else ("first",)):
        implementation(f"gaps.gesture_{_toolkit}_{_position}_mouse-click")(
            lambda ctx, toolkit=_toolkit, position=_position: gesture(ctx, toolkit, position))
