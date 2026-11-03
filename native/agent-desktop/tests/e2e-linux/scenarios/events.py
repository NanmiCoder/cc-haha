from __future__ import annotations

from runner.apps import launch, stop
from runner.helper import changed, delayed
from runner.legs import implementation
from runner.verdict import LegContext
from oracle.atspi_raw import app_root, registry
from oracle.proc import members
from scenarios.launch import _close_added_windows, _window_ids

TEXT_EDITOR = "Text Editor"
CALCULATOR = "Calculator"


def event_kind(data: dict | None) -> str:
    event = (data or {}).get("event") or {}
    return str(event.get("kind", "")).replace("_", "-")


def timed_out(envelope) -> bool:
    error = envelope.error or {}
    return (not envelope.ok) and error.get("code") == "TIMEOUT"


def root_windows(tier, owner: str) -> int:
    try:
        return len(app_root(tier, owner).children())
    except LookupError:
        return 0


def _names(tier, owner):
    return sorted(node.name for node in registry(tier) if node.name == owner)


def _restore_count(ctx, owner, before, app_name):
    replacement = launch(ctx.tier, app_name)
    try:
        ctx.restored("atspi.root_children", changed(lambda: root_windows(ctx.tier, owner), before))
    finally:
        stop(replacement)


def _editor(tier):
    app = launch(tier, TEXT_EDITOR)
    return app, app_root(tier, "gnome-text-editor")


def _new_editor_window(tier):
    return launch(tier, TEXT_EDITOR, ("--new-window",))


def _calculator(tier):
    app = launch(tier, CALCULATOR)
    return app, app_root(tier, "gnome-calculator")


def _wait(ctx: LegContext, token: str, *extra: str):
    return ctx.product(["wait", "--event", token, "--timeout", "8000", *extra])


@implementation("events.window_opened_quiet")
def window_opened_quiet(ctx: LegContext) -> None:
    app, root = _editor(ctx.tier)
    before = len(root.children())
    ctx.before("atspi.root_children", before)
    envelope = ctx.product(["wait", "--event", "window-opened", "--timeout", "1500"])
    assert timed_out(envelope), envelope.raw
    after = root_windows(ctx.tier, "gnome-text-editor")
    ctx.after("atspi.root_children", after)
    assert after == before
    ctx.restored("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    stop(app)


@implementation("events.window_closed_transition")
def window_closed_transition(ctx: LegContext) -> None:
    app, root = _editor(ctx.tier)
    before = len(root.children())
    frames = _window_ids(ctx.tier)
    ctx.before("atspi.root_children", before)
    trigger = delayed(0.8, lambda: stop(app))
    envelope = _wait(ctx, "window-closed")
    trigger.join()
    assert envelope.ok, envelope.raw
    assert event_kind(envelope.data) == "window-closed", envelope.raw
    event = (envelope.data or {}).get("event") or {}
    assert event.get("pid") == app.pid and event.get("window_id") in frames, envelope.raw
    remaining = changed(lambda: root_windows(ctx.tier, "gnome-text-editor"), 0)
    ctx.after("atspi.root_children", remaining)
    _restore_count(ctx, "gnome-text-editor", before, TEXT_EDITOR)


@implementation("events.window_closed_quiet")
def window_closed_quiet(ctx: LegContext) -> None:
    app, root = _editor(ctx.tier)
    before = len(root.children())
    ctx.before("atspi.root_children", before)
    envelope = ctx.product(["wait", "--event", "window-closed", "--timeout", "1500"])
    assert timed_out(envelope), envelope.raw
    ctx.after("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    ctx.restored("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    stop(app)


def app_launched_transition(ctx: LegContext) -> None:
    ctx.before("atspi.apps", _names(ctx.tier, "gnome-calculator"))
    launched = []
    trigger = delayed(0.5, lambda: launched.append(launch(ctx.tier, CALCULATOR)))
    envelope = _wait(ctx, "app-launched")
    trigger.join()
    assert envelope.ok, envelope.raw
    assert event_kind(envelope.data) == "app-launched", envelope.raw
    assert (envelope.data.get("event") or {}).get("pid") == launched[0].pid, envelope.raw
    ctx.after("atspi.apps", changed(lambda: _names(ctx.tier, "gnome-calculator"), ["gnome-calculator"]))
    stop(launched[0])
    ctx.restored("atspi.apps", changed(lambda: _names(ctx.tier, "gnome-calculator"), []))


@implementation("events.app_launched_quiet")
def app_launched_quiet(ctx: LegContext) -> None:
    ctx.before("atspi.apps", _names(ctx.tier, "gnome-calculator"))
    envelope = ctx.product(["wait", "--event", "app-launched", "--timeout", "1500"])
    assert timed_out(envelope), envelope.raw
    ctx.after("atspi.apps", _names(ctx.tier, "gnome-calculator"))
    ctx.restored("atspi.apps", _names(ctx.tier, "gnome-calculator"))


@implementation("events.app_terminated_transition")
def app_terminated_transition(ctx: LegContext) -> None:
    app, _root = _calculator(ctx.tier)
    ctx.before("atspi.apps", _names(ctx.tier, "gnome-calculator"))
    trigger = delayed(0.8, lambda: stop(app))
    envelope = _wait(ctx, "app-terminated")
    trigger.join()
    assert envelope.ok, envelope.raw
    assert event_kind(envelope.data) == "app-terminated", envelope.raw
    assert (envelope.data.get("event") or {}).get("pid") == app.pid, envelope.raw
    ctx.after("atspi.apps", changed(lambda: _names(ctx.tier, "gnome-calculator"), []))
    replacement = launch(ctx.tier, CALCULATOR)
    try:
        ctx.restored("atspi.apps", changed(lambda: _names(ctx.tier, "gnome-calculator"), ["gnome-calculator"]))
    finally:
        stop(replacement)


@implementation("events.scoped_and_unscoped_forms")
def scoped_and_unscoped_forms(ctx: LegContext) -> None:
    app, root = _editor(ctx.tier)
    before = len(root.children())
    existing = _window_ids(ctx.tier)
    ctx.before("atspi.root_children", before)
    for scope in (("--app", TEXT_EDITOR), ()):
        previous = set(_window_ids(ctx.tier))
        trigger = delayed(0.6, lambda: _new_editor_window(ctx.tier))
        envelope = _wait(ctx, "window-opened", *scope)
        trigger.join()
        assert envelope.ok, envelope.raw
        assert event_kind(envelope.data) == "window-opened", envelope.raw
        event = (envelope.data or {}).get("event") or {}
        added = set(_window_ids(ctx.tier)) - previous
        assert event.get("pid") == app.pid, envelope.raw
        assert len(added) == 1 and event.get("window_id") in added, envelope.raw
    ctx.after("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    _close_added_windows(ctx.tier, existing)
    ctx.restored("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    stop(app)


@implementation("events.open_and_close_inside_one_wait")
def open_and_close_inside_one_wait(ctx: LegContext) -> None:
    app, root = _editor(ctx.tier)
    ctx.before("atspi.root_children", len(root.children()))

    existing = _window_ids(ctx.tier)
    transient = []
    def cycle() -> None:
        _new_editor_window(ctx.tier)
        added = set(_window_ids(ctx.tier)) - set(existing)
        assert len(added) == 1, "transient cycle needs exactly one independently observed new frame"
        transient.extend(added)
        _close_added_windows(ctx.tier, existing)

    trigger = delayed(0.6, cycle)
    envelope = _wait(ctx, "window-closed")
    trigger.join()
    assert envelope.ok, envelope.raw
    assert event_kind(envelope.data) == "window-closed", envelope.raw
    event = envelope.data.get("event") or {}
    assert event.get("window_id") in transient and event.get("pid") == app.pid, envelope.raw
    ctx.after("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    ctx.restored("atspi.root_children", root_windows(ctx.tier, "gnome-text-editor"))
    stop(app)


@implementation("events.target_killed_mid_wait")
def target_killed_mid_wait(ctx: LegContext) -> None:
    app, _root = _editor(ctx.tier)
    read = lambda: any(pid == app.pid and start == app.start_time
                       for pid, start, _ in members(ctx.tier.runtime_dir))
    before = read()
    assert before, "the target process generation was not alive before the wait"
    ctx.before("proc.text_editor_alive", before)
    trigger = delayed(0.5, lambda: stop(app))
    envelope = ctx.product(
        ["wait", "--event", "window-closed", "--app", TEXT_EDITOR, "--timeout", "8000"]
    )
    trigger.join()
    assert envelope.ok, envelope.raw
    assert event_kind(envelope.data) == "window-closed", envelope.raw
    event = envelope.data.get("event") or {}
    if envelope.data.get("target_unresolved") is True:
        assert event.get("app") == TEXT_EDITOR, envelope.raw
    else:
        assert event.get("pid") == app.pid and event.get("window_id") in app.windows, envelope.raw
    ctx.after("proc.text_editor_alive", changed(read, False))
    app = launch(ctx.tier, TEXT_EDITOR)
    try:
        ctx.restored("proc.text_editor_alive", changed(read, before))
    finally:
        stop(app)
