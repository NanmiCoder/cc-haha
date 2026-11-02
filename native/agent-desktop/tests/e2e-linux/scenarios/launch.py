from __future__ import annotations

from scenarios.headed_actions import find_ref as qualified_ref

from runner.apps import launch, stop, window_id
from runner.helper import changed
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import app_root, registry
from oracle.proc import members

CALCULATOR = "Calculator"
TEXT_EDITOR = "Text Editor"
TERMINAL = "Terminal"


def error_code(envelope) -> str:
    return str((envelope.error or {}).get("code", ""))


@implementation("launch.launch_calculator_attributed")
def launch_calculator_attributed(ctx: LegContext) -> None:
    before = members(ctx.tier.runtime_dir)
    ctx.before("proc.members", before)
    envelope = ctx.product(["launch", CALCULATOR])
    assert envelope.ok, envelope.raw
    launched = (envelope.data or {}).get("pid")
    assert isinstance(launched, int), envelope.raw
    after = members(ctx.tier.runtime_dir)
    ctx.after("proc.members", after)
    assert any(member[0] == launched for member in after), "the launched pid is not a member"
    window = ctx.product(["list-windows", "--app", CALCULATOR])
    assert window.ok and window.data, window.raw
    assert app_root(ctx.tier, "gnome-calculator")
    closed = ctx.product(["close-app", CALCULATOR])
    assert closed.ok, closed.raw
    ctx.restored("proc.members", changed(lambda: members(ctx.tier.runtime_dir), before, seconds=6))


def _window_ids(tier):
    return sorted(window_id(node) for node in app_root(tier, "gnome-text-editor").children()
                  if node.role in (16, 23, 69))


def _close_added_windows(tier, existing):
    for frame in app_root(tier, "gnome-text-editor").children():
        if frame.role in (16, 23, 69) and window_id(frame) not in existing:
            close = frame.find(role=43, name="Close")
            assert len(close) == 1, "new editor frame must have one Close action"
            assert close[0].do_action("click"), "new editor frame did not close"
    return changed(lambda: _window_ids(tier), existing)


@implementation("launch.launch_text_editor_new_window")
def launch_text_editor_new_window(ctx: LegContext) -> None:
    first = launch(ctx.tier, TEXT_EDITOR)
    try:
        existing = _window_ids(ctx.tier)
        ctx.before("atspi.window_ids", existing)
        envelope = ctx.product(["launch", TEXT_EDITOR, "--arg=--new-window"])
        assert envelope.ok, envelope.raw
        after = _window_ids(ctx.tier)
        ctx.after("atspi.window_ids", after)
        assert set(after) - set(existing), "a second launch added no window"
        ctx.restored("atspi.window_ids", _close_added_windows(ctx.tier, existing))
    finally:
        stop(first)


@implementation("launch.launch_terminal_owner")
def launch_terminal_owner(ctx: LegContext) -> None:
    read = lambda: [member[2] for member in members(ctx.tier.runtime_dir) if "gnome-terminal" in member[2]]
    before = read()
    ctx.before("proc.terminal_owner", before)
    envelope = ctx.product(["launch", TERMINAL])
    assert envelope.ok, envelope.raw
    owners = read()
    ctx.after("proc.terminal_owner", owners)
    assert owners, "no gnome-terminal-server owner in the runtime directory"
    assert app_root(ctx.tier, "gnome-terminal-server")
    closed = ctx.product(["close-app", TERMINAL])
    assert closed.ok, closed.raw
    ctx.restored("proc.terminal_owner", changed(read, before, seconds=6))


@implementation("launch.list_apps_alias")
def list_apps_alias(ctx: LegContext) -> None:
    app = launch(ctx.tier, CALCULATOR)
    read = lambda: sorted(node.name for node in registry(ctx.tier))
    try:
        before = read()
        ctx.before("atspi.apps", before)
        expected = [(app_root(ctx.tier, "gnome-calculator").name, app.pid)]
        for alias in (CALCULATOR, "calculator"):
            envelope = ctx.product(["list-apps", "--app", alias])
            assert envelope.ok, envelope.raw
            data = envelope.data or {}
            assert [(row.get("name"), row.get("pid")) for row in data.get("apps", [])] == expected, envelope.raw
            assert data.get("complete") is not False, envelope.raw
        ctx.after("atspi.apps", read())
        assert read() == before, "query changed registered applications"
        ctx.restored("atspi.apps", read())
    finally:
        stop(app)


@implementation("launch.launch_suggestion")
def launch_suggestion(ctx: LegContext) -> None:
    read = lambda: members(ctx.tier.runtime_dir)
    ctx.before("proc.apps", read())
    envelope = ctx.product(["launch", "No Such Application For Harness"])
    ctx.after("proc.apps", read())
    assert not envelope.ok, envelope.raw
    assert error_code(envelope) == "APP_NOT_FOUND", envelope.raw
    suggestion = (envelope.error or {}).get("suggestion")
    assert suggestion, "the APP_NOT_FOUND envelope carries no suggestion"
    ctx.restored("proc.apps", read())


@implementation("launch.recovery_strategy_on_error")
def recovery_strategy_on_error(ctx: LegContext) -> None:
    app = launch(ctx.tier, CALCULATOR)
    snapshot = ctx.product(["snapshot", "--app", CALCULATOR, "-i"])
    assert snapshot.ok, snapshot.raw
    ref = _first_ref((snapshot.data or {}).get("tree"))
    assert ref, "the snapshot allocated no ref"
    stop(app)
    read = lambda: any(member[0] == app.pid for member in members(ctx.tier.runtime_dir))
    assert not read(), "stale-ref setup did not stop Calculator"
    ctx.before("proc.calculator", read())
    envelope = ctx.product(["click", ref])
    ctx.after("proc.calculator", read())
    assert not read(), "stale click relaunched the dead owner"
    assert not envelope.ok, envelope.raw
    assert error_code(envelope) == "STALE_REF", envelope.raw
    error = envelope.error or {}
    details = error.get("details") or {}
    assert details.get("process_state") == "exited", envelope.raw
    assert details.get("retryable") is False, envelope.raw
    assert error.get("disposition") == {"delivery": "not_delivered", "retry": "safe"}, envelope.raw
    assert "recovery" not in error, envelope.raw
    ctx.restored("proc.calculator", read())


def _first_ref(tree: dict | None) -> str | None:
    return qualified_ref(tree)
