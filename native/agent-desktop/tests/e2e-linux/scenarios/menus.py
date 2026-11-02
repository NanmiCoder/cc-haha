from __future__ import annotations

from runner.apps import launch, stop
from runner.helper import changed, command, managed, ref, require, snapshot
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import app_root, registry
from oracle import x11

CALCULATOR = "Calculator"
TERMINAL = "Terminal"


def timeout_details(envelope) -> dict:
    return (envelope.error or {}).get("details") or {}


def is_timeout(envelope) -> bool:
    return (not envelope.ok) and (envelope.error or {}).get("code") == "TIMEOUT"


def _click_named(tier, owner: str, name: str) -> bool:
    matches = app_root(tier, owner).find(name=name)
    toggles = [node for node in matches if node.role == 62]
    if toggles:
        assert len(toggles) == 1, "ambiguous menu toggle"
        return toggles[0].do_action("click")
    if not matches:
        return False
    return matches[0].do_action("click")


def _visible(tier, owner):
    return any("SHOWING" in node.states for node in app_root(tier, owner).find(role=35))


def _toggle(tier, owner):
    assert _click_named(tier, owner, "Main Menu") or _click_named(tier, owner, "Menu"), "menu opener missing"


def _menu_case(ctx, name, operation):
    owner = "gnome-calculator" if name == CALCULATOR else "gnome-terminal-server"
    app = launch(ctx.tier, name)
    read = lambda: _visible(ctx.tier, owner)
    try:
        if operation in ("close", "already"):
            _toggle(ctx.tier, owner)
            changed(read, True)
        before = read()
        assert before == (operation in ("close", "already")), "unexpected initial menu visibility"
        ctx.before("atspi.menu_visible", before)
        if operation in ("open", "close"):
            _toggle(ctx.tier, owner)
        args = ["wait", "--menu-closed" if operation == "close" else "--menu", "--app", owner,
                "--timeout", "1500" if operation == "hidden" else "4000"]
        envelope = ctx.product(args)
        if operation == "hidden":
            assert is_timeout(envelope), envelope.raw
            details = timeout_details(envelope)
            assert details.get("kind") == "wait_timeout", envelope.raw
            assert details.get("predicate") == "menu", envelope.raw
            assert details.get("timeout_ms") == 1500, envelope.raw
        else:
            assert envelope.ok, envelope.raw
            if operation == "already":
                assert envelope.elapsed_ms < 1500, f"already-open menu took {envelope.elapsed_ms} ms"
        expected = operation in ("open", "already")
        ctx.after("atspi.menu_visible", changed(read, expected))
        if read() != before:
            _toggle(ctx.tier, owner)
        ctx.restored("atspi.menu_visible", changed(read, before))
    finally:
        stop(app)


@implementation("menus.wait_menu_opens_calculator")
def wait_menu_opens_calculator(ctx: LegContext) -> None:
    _menu_case(ctx, CALCULATOR, "open")


@implementation("menus.wait_menu_closes_calculator")
def wait_menu_closes_calculator(ctx: LegContext) -> None:
    _menu_case(ctx, CALCULATOR, "close")


@implementation("menus.wait_menu_already_open")
def wait_menu_already_open(ctx: LegContext) -> None:
    _menu_case(ctx, CALCULATOR, "already")


@implementation("menus.hidden_bar_timeout_message")
def hidden_bar_timeout_message(ctx: LegContext) -> None:
    _menu_case(ctx, TERMINAL, "hidden")


@implementation("menus.preferences_find_ref")
def preferences_find_ref(ctx: LegContext) -> None:
    with managed(ctx, CALCULATOR) as app:
        def dialogs():
            return [node for owner in registry(ctx.tier) if owner.bus in app.owner_names
                    for node in owner.walk() if node.name == "Preferences"
                    and node.role in (16, 23) and "SHOWING" in node.states]

        def read():
            return len(dialogs())

        command(ctx, ["focus-window", "--app", CALCULATOR])
        require(read() == 0, "Preferences was already open")
        ctx.before("atspi.preferences_dialogs", 0)
        opener = ref(ctx, app, name="Main Menu", role="switch")
        command(ctx, ["click", opener])
        command(ctx, ["wait", "--menu", "--app", CALCULATOR, "--timeout", "5000"])
        snapshot(ctx, app, "--surface", "menu")
        target = ref(ctx, app, name="Preferences", surface="menu")
        pointer = x11.pointer(ctx.tier)
        active = x11.active_window(ctx.tier)
        response = ctx.product(["click", target])
        require(response.ok, response.raw)
        ctx.after("atspi.preferences_dialogs", changed(read, 1, seconds=8))
        if ctx.mode == "headless":
            require(x11.pointer(ctx.tier) == pointer, "headless modal click moved the pointer")
            steps = response.data.get("steps", [])
            require(steps and all(step.get("mechanism") == "semantic_api" for step in steps),
                    "headless modal click used physical input")
            focused = x11.active_window(ctx.tier)
            if focused != active:
                allowed = {x11.encode_product_id(node.bus, node.path) for node in dialogs()}
                require(focused and x11.product_window(ctx.tier, focused) in allowed,
                        "modal click focused a window other than the new Preferences dialog")
    ctx.restored("atspi.preferences_dialogs", changed(read, 0, seconds=5))
