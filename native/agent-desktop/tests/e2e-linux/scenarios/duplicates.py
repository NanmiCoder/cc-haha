from oracle import atspi_raw as raw, x11
from runner import apps
from runner.helper import (command, managed, ref, require, root, snapshot)
from runner.legs import implementation
from runner.verdict import LegContext


def focus_exact(ctx, app):
    command(ctx, ["focus-window", "--window-id", app.windows[0]])
    tree = root(ctx, app)
    require(raw.poll(lambda: any("ACTIVE" in node.states for node in tree.children()
                                if node.role in (16, 23, 69)), 2.5),
            "focus did not activate the addressed frame")
    active = x11.active_window(ctx.tier)
    require(active is not None)
    from oracle.gsettings import tool
    pid_text = tool(ctx.tier, ["xprop", "-id", active, "_NET_WM_PID"])
    require(int(pid_text.split("=")[-1].strip()) == app.pid, "another process got focus")


@implementation("duplicates.two_processes_distinct_window_ids")
def two_processes_distinct_window_ids(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as first:
        with managed(ctx, "Calculator") as second:
            owners = apps.owners_named(ctx.tier, "Calculator")
            require(len(owners) == 2 and first.pid != second.pid)
            require(set(first.windows).isdisjoint(second.windows))
            evidence = sorted((item.pid, item.start_time, item.windows) for item in owners)
            ctx.before("atspi", evidence)
            for app in (first, second):
                data = snapshot(ctx, app)
                require(data["window"]["id"] == app.windows[0])
                focus_exact(ctx, app)
            after = sorted((item.pid, item.start_time, item.windows)
                           for item in apps.owners_named(ctx.tier, "Calculator"))
            require(after == evidence)
            ctx.after("atspi", after)
            ctx.restored("atspi", sorted((item.pid, item.start_time, item.windows)
                                         for item in apps.owners_named(ctx.tier, "Calculator")))


@implementation("duplicates.main_menu_nodes_separate")
def main_menu_nodes_separate(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        raw_nodes = tree.find(name="Main Menu")
        require({43, 62}.issubset({item.role for item in raw_nodes}))
        evidence = [(item.path, item.role) for item in raw_nodes]
        ctx.before("atspi", evidence)
        targets = [ref(ctx, app, role=role, name="Main Menu") for role in ("menubutton", "switch")]
        require(len(set(targets)) == 2)
        for target, role in zip(targets, ("menubutton", "switch")):
            response = command(ctx, ["get", target, "--property", "role"], app)
            require(response.data["value"] == role)
        after = [(item.path, item.role) for item in tree.find(name="Main Menu")]
        require(after == evidence)
        ctx.after("atspi", after)
        ctx.restored("atspi", [(item.path, item.role) for item in tree.find(name="Main Menu")])
