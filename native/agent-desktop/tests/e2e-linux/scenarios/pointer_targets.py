from contextlib import contextmanager

from runner.helper import activate, changed, display, managed, one, require, root
from scenarios.ref_effects import centre, clear_selection, editor, selections
from scenarios.scroll import raw_value


@contextmanager
def delivery_target(ctx, verb):
    if verb == "mouse-click":
        with managed(ctx, "Calculator") as app:
            tree = root(ctx, app)
            button = one(tree, role=43, name="7")
            read = lambda: display(tree)
            initial = read()
            point = centre(ctx, app, button)
            def restore():
                if read() != initial:
                    activate(one(tree, role=43, name="Undo"))
                changed(read, initial)
            yield point, ["mouse-click", "--xy", f"{point[0]},{point[1]}"], read, restore
    else:
        with editor(ctx) as (app, tree, field, target):
            point = centre(ctx, app, field)
            if verb == "drag":
                require(field.extents(window_coords=True)[2] > 180, "document too narrow for drag")
                read = lambda: selections(field)
                restore = lambda: clear_selection(ctx, app, field)
                argv = ["drag", "--from-xy", f"{point[0]},{point[1]}",
                        "--to-xy", f"{point[0] + 90},{point[1]}"]
            else:
                bars = [node for node in tree.find(role=48)
                        if "VERTICAL" in node.states and node.value() is not None]
                require(len(bars) == 1, "no unique editor scrollbar")
                bar = bars[0]
                read = bar.value
                initial = read()
                def restore():
                    raw_value(bar, initial)
                    changed(read, initial)
                argv = ["mouse-wheel", "--x", str(point[0]), "--y", str(point[1]), "--dy", "-3"]
            yield point, argv, read, restore
