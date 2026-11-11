from oracle import gsettings
from runner import apps
from runner.helper import (changed, command, managed, one, ref, require, root,
                           stale_twin)
from runner.legs import implementation
from runner.verdict import LegContext


def key_number(value):
    return float(value.split()[-1])


@implementation("values.hot_corner_flip_restore")
def hot_corner_flip_restore(ctx: LegContext) -> None:
    schema, key = "org.gnome.desktop.interface", "enable-hot-corners"
    initial = gsettings.get(ctx.tier, schema, key)
    with managed(ctx, "Settings", ("multitasking",)) as app:
        switch = one(root(ctx, app), role=7, name="Hot Corner")
        target = ref(ctx, app, role="switch", name="Hot Corner")
        checked = "CHECKED" in switch.states
        require(checked == (initial == "true"))
        ctx.before("gsettings", initial)
        try:
            command(ctx, ["toggle", target], app)
            wanted = "false" if checked else "true"
            changed(lambda: gsettings.get(ctx.tier, schema, key), wanted)
            changed(lambda: "CHECKED" in switch.states, not checked)
            ctx.after("gsettings", gsettings.get(ctx.tier, schema, key))
            for verb, expected in (("check", True), ("uncheck", False)):
                command(ctx, [verb, target], app)
                changed(lambda: "CHECKED" in switch.states, expected)
                changed(lambda: gsettings.get(ctx.tier, schema, key), str(expected).lower())
            stale_twin(ctx, app, target, lambda: gsettings.get(ctx.tier, schema, key), ("toggle",))
        finally:
            command(ctx, ["check" if checked else "uncheck", target], app)
            changed(lambda: gsettings.get(ctx.tier, schema, key), initial)
            ctx.restored("gsettings", gsettings.get(ctx.tier, schema, key))


def numeric_commit(ctx, panel, label, schema, key, wanted, role, raw_role):
    initial = gsettings.get(ctx.tier, schema, key)
    with managed(ctx, "Settings", (panel,)) as app:
        raw_target = one(root(ctx, app), role=raw_role, name=label)
        target = ref(ctx, app, role=role, name=label)
        ctx.before("gsettings", initial)
        try:
            command(ctx, ["set-value", target, str(wanted)], app)
            changed(lambda: key_number(gsettings.get(ctx.tier, schema, key)), wanted)
            changed(raw_target.value, wanted)
            stale_twin(ctx, app, target, lambda: gsettings.get(ctx.tier, schema, key),
                       ("set-value", str(wanted)))
            apps.stop(app)
            with managed(ctx, "Settings", (panel,)) as reopened:
                control = one(root(ctx, reopened), role=raw_role, name=label)
                require(control.value() == wanted, "value did not survive panel reopen")
                ctx.after("gsettings", gsettings.get(ctx.tier, schema, key))
                new_ref = ref(ctx, reopened, role=role, name=label)
                command(ctx, ["set-value", new_ref, str(key_number(initial))], reopened)
                changed(lambda: gsettings.get(ctx.tier, schema, key), initial)
        finally:
            if gsettings.get(ctx.tier, schema, key) != initial:
                gsettings.set(ctx.tier, schema, key, initial)
            require(gsettings.get(ctx.tier, schema, key) == initial)
            ctx.restored("gsettings", gsettings.get(ctx.tier, schema, key))


@implementation("values.pointer_speed_commit")
def pointer_speed_commit(ctx: LegContext) -> None:
    schema, key = "org.gnome.desktop.peripherals.mouse", "speed"
    initial = key_number(gsettings.get(ctx.tier, schema, key))
    wanted = -0.25 if initial == 0.25 else 0.25
    numeric_commit(ctx, "mouse", "Pointer Speed", schema, key, wanted, "slider", 51)


@implementation("values.terminal_read_only_flip")
def terminal_read_only_flip(ctx: LegContext) -> None:
    with managed(ctx, "Terminal", ("--show-menubar",)) as app:
        tree = root(ctx, app)
        item = one(tree, role=8, name="Read-Only")
        initial = "CHECKED" in item.states
        menu = ref(ctx, app, role="menu", name="Terminal")
        command(ctx, ["click", menu], app)
        command(ctx, ["wait", "--menu", "--app", "Terminal", "--timeout", "5000"])
        target = ref(ctx, app, role="menuitem", name="Read-Only", surface="menu")
        ctx.before("atspi", initial)
        try:
            command(ctx, ["click", target], app)
            changed(lambda: "CHECKED" in item.states, not initial)
            ctx.after("atspi", "CHECKED" in item.states)
            stale_twin(ctx, app, target, lambda: "CHECKED" in item.states)
        finally:
            if ("CHECKED" in item.states) != initial:
                command(ctx, ["click", menu], app)
                command(ctx, ["wait", "--menu", "--app", "Terminal", "--timeout", "5000"])
                target = ref(ctx, app, role="menuitem", name="Read-Only", surface="menu")
                command(ctx, ["click", target], app)
            changed(lambda: "CHECKED" in item.states, initial)
            ctx.restored("atspi", "CHECKED" in item.states)
