from contextlib import contextmanager

from oracle import x11
from runner.helper import changed, managed, one, ref, require, root

TEXT = "org.a11y.atspi.Text"
LINE = "alpha bravo charlie delta echo foxtrot golf hotel india juliet"


def selections(field):
    count = field.invoke(TEXT, "GetNSelections")[0]
    return tuple(tuple(field.invoke(TEXT, "GetSelection", "(i)", (index,)))
                 for index in range(count))


def clear_selection(ctx, app, field):
    if field.invoke(TEXT, "GetNSelections")[0]:
        require(x11.active_window(ctx.tier) == x11.xid(ctx.tier, app.windows[0]),
                "selection cleanup target is not active")
        x11.tool(ctx.tier, ["xdotool", "key", "Right"])
    changed(lambda: selections(field), ())


def menus(tree):
    return tuple(sorted((node.role, node.name) for node in tree.walk()
                        if node.role in (33, 35) and "SHOWING" in node.states))


def centre(ctx, app, node):
    from scenarios.pointer import expected_point, frame_extents
    window = app.windows[0]
    return expected_point(x11.client_origin(ctx.tier, window),
                          frame_extents(ctx.tier, window), node.extents(window_coords=True))


def desktop(tier):
    return x11.pointer(tier), x11.active_window(tier)


@contextmanager
def desktop_restored(ctx):
    before = desktop(ctx.tier)
    ctx.before("x11.desktop", before)
    try:
        yield
    finally:
        after = desktop(ctx.tier)
        ctx.after("x11.desktop", after)
        if x11.active_window(ctx.tier) != before[1]:
            x11.restore_active(ctx.tier, before[1])
        x11.tool(ctx.tier, ["xdotool", "mousemove", str(before[0][0]), str(before[0][1])])
        ctx.restored("x11.desktop", changed(lambda: desktop(ctx.tier), before))
        if ctx.mode == "headless":
            require(after == before, "headless action moved pointer or focus")


@contextmanager
def editor(ctx):
    with managed(ctx, "Text Editor", ("--new-window",)) as app:
        tree = root(ctx, app)
        field = one(tree, role=61)
        require(field.invoke("org.a11y.atspi.EditableText", "SetTextContents", "(s)", ("",))[0])
        original = changed(field.text, "")
        ctx.before("atspi.document_preparation", original)
        try:
            expected = (LINE + "\n") * 120
            require(field.invoke("org.a11y.atspi.EditableText", "SetTextContents", "(s)", (expected,))[0])
            ctx.after("atspi.document_preparation", changed(field.text, expected))
            target = ref(ctx, app, role="textfield")
            clear_selection(ctx, app, field)
            yield app, tree, field, target
        finally:
            require(field.invoke("org.a11y.atspi.EditableText", "SetTextContents", "(s)", (original,))[0])
            ctx.restored("atspi.document_preparation", changed(field.text, original))


def policy_refusal(ctx, argv, read, before):
    response = ctx.product(argv)
    require(not response.ok and (response.error or {}).get("code") == "POLICY_DENIED",
            f"expected headless policy refusal: {response.raw}")
    require(read() == before, "refused action changed the application")
    return response
