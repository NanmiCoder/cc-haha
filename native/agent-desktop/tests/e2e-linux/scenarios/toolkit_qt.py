import contextlib
import json
import time

from oracle.atspi_raw import poll
from oracle.proc import members
from runner.helper import (command, delayed, managed, one, ref, require, root,
                           snapshot, stale_twin, remove)
from runner.legs import implementation
from runner.verdict import LegContext


def log_state(ctx):
    path = ctx.tier.runtime_dir / "qt-window.log"
    return {"members": members(ctx.tier.runtime_dir),
            "log": path.read_text() if path.exists() else None}


@contextlib.contextmanager
def qt_app(ctx):
    path = ctx.tier.runtime_dir / "qt-window.log"
    remove(path)
    baseline = log_state(ctx)
    ctx.before("applog", baseline)
    try:
        with managed(ctx, "Qt") as app:
            yield app
    finally:
        remove(path)
        restored = log_state(ctx)
        require(restored == baseline)
        ctx.restored("applog", restored)


def events(path):
    return [json.loads(line)["event"] for line in path.read_text().splitlines()]


def click_delta(before, after):
    require(after[:len(before)] == before, "activation log was rewritten")
    return after[len(before):].count("click")


def menu_state(records):
    transitions = [event for event in records if event in ("menu-open", "menu-closed")]
    return bool(transitions and transitions[-1] == "menu-open")


def menu_open(path):
    return menu_state(events(path))


def open_raw(tree):
    menu = one(tree, name="File")
    require(menu.do_action("showMenu") or menu.do_action("press") or menu.do_action("click"))


def wait_menu(ctx, app, opened, *, timeout=2000, code=None):
    return command(ctx, ["wait", "--menu" if opened else "--menu-closed", "--app", app.name,
                         "--timeout", str(timeout)], code=code)


@implementation("toolkit_qt.refs_and_completeness")
def refs_and_completeness(ctx: LegContext) -> None:
    with qt_app(ctx) as app:
        path = ctx.tier.runtime_dir / "qt-window.log"
        before = events(path)
        data = snapshot(ctx, app)
        require(data["ref_count"] >= 3)
        for role, name in (("button", "Press me"), ("textfield", "Text entry")):
            ref(ctx, app, role=role, name=name)
        require(events(path) == before)
        ctx.after("applog", log_state(ctx))


def click_once(ctx, headed):
    with qt_app(ctx) as app:
        path = ctx.tier.runtime_dir / "qt-window.log"
        target = ref(ctx, app, role="button", name="Press me")
        before = events(path)
        command(ctx, ["click", target], app, headed=headed)
        require(poll(lambda: click_delta(before, events(path)) == 1, 2, floor_s=0.3))
        require(click_delta(before, events(path)) == 1, "click dispatched more than once")
        ctx.after("applog", log_state(ctx))
        stale_twin(ctx, app, target, lambda: events(path))


@implementation("toolkit_qt.headless_click_logged_once")
def headless_click_logged_once(ctx: LegContext) -> None:
    click_once(ctx, False)


@implementation("toolkit_qt.headed_click_logged_once")
def headed_click_logged_once(ctx: LegContext) -> None:
    click_once(ctx, True)


@implementation("toolkit_qt.scroll_refused_no_container")
def scroll_refused_no_container(ctx: LegContext) -> None:
    with qt_app(ctx) as app:
        tree = root(ctx, app)
        path = ctx.tier.runtime_dir / "qt-window.log"
        target = ref(ctx, app, role="textfield", name="Offscreen entry")
        field = one(tree, name="Offscreen entry")
        frame = one(tree, role=23)
        require(field.extents()[1] >= frame.extents()[1] + frame.extents()[3],
                "scroll refusal target must be outside the viewport")
        before = field.text(), events(path)
        response = command(ctx, ["scroll-to", target], app, code="ACTION_NOT_SUPPORTED")
        require(response.error.get("details", {}).get("cause") == "no_scroll_container", response.raw)
        require((field.text(), events(path)) == before)
        ctx.after("applog", log_state(ctx))


def menu_transition(ctx, opening, *, already=False):
    with qt_app(ctx) as app:
        tree = root(ctx, app)
        path = ctx.tier.runtime_dir / "qt-window.log"
        require(not menu_open(path), "Qt menu initially open")
        initial = events(path)
        trigger = None
        try:
            wait_menu(ctx, app, True, timeout=200, code="TIMEOUT")
            require(not menu_open(path) and events(path) == initial)
            if not opening or already:
                open_raw(tree)
                require(poll(lambda: menu_open(path), 2))
            if already:
                started = time.monotonic()
                wait_menu(ctx, app, True)
                require(time.monotonic() - started < 1.5)
            else:
                callback = (lambda: open_raw(tree)) if opening else (lambda: command(ctx, ["press", "escape"], app, headed=True))
                trigger = delayed(0.4, callback)
                wait_menu(ctx, app, opening)
                trigger.join()
            require(poll(lambda: menu_open(path) == (opening or already), 2))
            after = events(path)
            require("menu-open" in after[len(initial):])
            if not opening and not already:
                require("menu-closed" in after[len(initial):])
            ctx.after("applog", log_state(ctx))
            wait_menu(ctx, app, not (opening or already), timeout=200, code="TIMEOUT")
        finally:
            if trigger:
                trigger.cancel()
            if menu_open(path):
                command(ctx, ["press", "escape"], app, headed=True)
            require(poll(lambda: not menu_open(path), 2))


@implementation("toolkit_qt.wait_menu_opens")
def wait_menu_opens(ctx: LegContext) -> None:
    menu_transition(ctx, True)


@implementation("toolkit_qt.wait_menu_closes")
def wait_menu_closes(ctx: LegContext) -> None:
    menu_transition(ctx, False)


@implementation("toolkit_qt.menu_already_open")
def menu_already_open(ctx: LegContext) -> None:
    menu_transition(ctx, True, already=True)
