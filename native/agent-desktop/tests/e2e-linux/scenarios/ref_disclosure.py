from oracle.atspi_raw import poll
from runner.helper import command, managed, one, ref, require, root
from runner.legs import implementation
from scenarios.ref_effects import desktop_restored, menus


def disclosure(ctx, expanding):
    with managed(ctx, "Calculator") as app, desktop_restored(ctx):
        tree = root(ctx, app)
        button = one(tree, role=43, name="Main Menu")
        target = ref(ctx, app, name="Main Menu", role="menubutton")
        read = lambda: ("EXPANDED" in button.states, menus(tree))
        original = read()
        require(original == (False, ()), "menu initially expanded")
        ctx.before("atspi.preparation", original)
        try:
            if not expanding:
                command(ctx, ["expand", target], app)
                require(poll(lambda: read()[0] and bool(read()[1]), 3), "setup did not expand menu")
            ctx.after("atspi.preparation", read())
            before = read()
            ctx.before("atspi.disclosure", before)
            try:
                command(ctx, ["expand" if expanding else "collapse", target], app)
                require(poll(lambda: read()[0] == expanding and bool(read()[1]) == expanding, 3),
                        "disclosure state and menu children did not change together")
                ctx.after("atspi.disclosure", read())
            finally:
                command(ctx, ["collapse" if expanding else "expand", target], app)
                require(poll(lambda: read() == before, 3), "disclosure was not restored")
                ctx.restored("atspi.disclosure", read())
        finally:
            command(ctx, ["collapse", target], app)
            require(poll(lambda: read() == original, 3), "menu preparation was not restored")
            ctx.restored("atspi.preparation", read())


@implementation("ref_actions.expand")
def expand(ctx):
    disclosure(ctx, True)


@implementation("ref_actions.collapse")
def collapse(ctx):
    disclosure(ctx, False)
