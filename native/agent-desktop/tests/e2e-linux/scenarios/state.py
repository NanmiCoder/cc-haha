from runner.helper import (changed, command, managed, one, ref, require, root, stale_twin)
from runner.legs import implementation
from runner.verdict import LegContext


@implementation("state.terminal_copy_follows_selection")
def terminal_copy_follows_selection(ctx: LegContext) -> None:
    with managed(ctx, "Terminal", ("--show-menubar",)) as app:
        tree = root(ctx, app)
        terminal = one(tree, role=60)
        copy = one(tree, name="Copy", role=35)
        target = ref(ctx, app, name="Copy", role="menuitem")
        interface = "org.a11y.atspi.Text"
        length = terminal.get_property(interface, "CharacterCount")
        require(length > 0 and "SENSITIVE" not in copy.states, "Copy not initially disabled")
        ctx.before("atspi", "SENSITIVE" in copy.states)
        require(command(ctx, ["is", target, "--property", "enabled"], app).data["result"] is False)
        try:
            require(terminal.invoke(interface, "AddSelection", "(ii)", (0, length))[0])
            changed(lambda: "SENSITIVE" in copy.states, True)
            require(command(ctx, ["is", target, "--property", "enabled"], app).data["result"] is True)
            ctx.after("atspi", "SENSITIVE" in copy.states)
        finally:
            count = terminal.invoke(interface, "GetNSelections")[0]
            for index in reversed(range(count)):
                require(terminal.invoke(interface, "RemoveSelection", "(i)", (index,))[0])
            changed(lambda: "SENSITIVE" in copy.states, False)
            ctx.restored("atspi", "SENSITIVE" in copy.states)


@implementation("state.text_editor_semantic_type")
def text_editor_semantic_type(ctx: LegContext) -> None:
    with managed(ctx, "Text Editor", ("--new-window",)) as app:
        tree = root(ctx, app)
        field = one(tree, role=61)
        target = ref(ctx, app, role="textfield")
        initial = field.text()
        require(initial == "", "document must start empty")
        ctx.before("atspi", initial)
        try:
            command(ctx, ["type", target, "Desktop café"], app)
            changed(field.text, "Desktop café")
            ctx.after("atspi", field.text())
            stale_twin(ctx, app, target, field.text, ("type", "ignored"))
        finally:
            command(ctx, ["clear", target], app)
            changed(field.text, initial)
            ctx.restored("atspi", field.text())
