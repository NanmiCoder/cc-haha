from __future__ import annotations

import json

from oracle import atspi_raw as raw
from runner.helper import activate, changed, managed, nodes, require, root, snapshot
from runner.legs import implementation
from scenarios.menus import _toggle


def dialogs(ctx, app):
    return [node for node in root(ctx, app).children()
            if "SHOWING" in node.states and (node.role == 16 or "MODAL" in node.states)]


def dialog_state(ctx, app):
    return tuple(sorted((node.role, node.name, "MODAL" in node.states)
                        for node in dialogs(ctx, app)))


def about_items(ctx, app):
    _toggle(ctx.tier, app.owner_names[0])
    previous = [0]

    def settled():
        items = [node for node in root(ctx, app).find(role=35) if "SHOWING" in node.states]
        ready = bool(items) and previous[0] == len(items)
        previous[0] = len(items)
        return items if ready else None

    items = raw.poll(settled, 4)
    require(items, "Calculator menu items did not settle")
    return items


def open_about(ctx, app):
    activate(about_items(ctx, app)[-1])
    require(raw.poll(lambda: len(dialogs(ctx, app)) == 1, 5), "About did not show")
    require("About" in dialog_state(ctx, app)[0][1], "the opener produced another dialog")


def dismiss_about(ctx, app):
    showing = dialogs(ctx, app)
    require(len(showing) == 1 and "About" in showing[0].name, "one showing About required")
    close = showing[0].find(role=43, name="Close")
    require(len(close) == 1, "one About Close control required")
    activate(close[0])
    changed(lambda: dialog_state(ctx, app), ())


def prepare_about(ctx, app):
    about_items(ctx, app)
    tree = snapshot(ctx, app, "--surface", "menu")
    entries = [node for node in nodes(tree.get("tree"))
               if node.get("role") == "menuitem" and node.get("name") == "About Calculator"
               and "ref_id" in node]
    require(len(entries) == 1, f"expected one About Calculator ref: {tree}")
    return entries[0]["ref_id"]


def seeded_wait(ctx, token, target, surface):
    response = ctx.product(["batch", json.dumps([
        {"command": "click", "args": {"ref_id": target}},
        {"command": "wait", "args": {"event": token, "app": "Calculator", "timeout": 8000}},
    ])])
    require(response.ok, response.raw)
    entries = (response.data or {}).get("results", [])
    require(len(entries) == 2 and all(entry.get("ok") is True for entry in entries), response.raw)
    event = (entries[-1].get("data") or {}).get("event") or {}
    require(event.get("kind") == token.replace("-", "_") and event.get("surface") == surface,
            response.raw)
    return event


def assert_owner(event, app):
    require(event.get("pid") == app.pid, f"surface event belongs to another process: {event}")
    require("calculat" in event.get("app", "").casefold(), f"wrong surface app: {event}")


@implementation("surfaces.batch_seed_opener_about")
def batch_seed_opener_about(ctx):
    with managed(ctx, "Calculator") as app:
        read = lambda: dialog_state(ctx, app)
        before = read()
        require(before == (), "About already open")
        ctx.before("atspi.dialogs", before)
        target = prepare_about(ctx, app)
        try:
            event = seeded_wait(ctx, "surface-appeared", target, "sheet")
            assert_owner(event, app)
            require(raw.poll(lambda: len(read()) == 1, 5), "seeded opener added no raw dialog")
            require("About" in read()[0][1], "the batch opener produced another dialog")
            require(event.get("title") == (read()[0][1] or None), "event names another dialog")
            ctx.after("atspi.dialogs", read())
        finally:
            if read():
                dismiss_about(ctx, app)
            ctx.restored("atspi.dialogs", changed(read, before))


@implementation("surfaces.baseline_after_opener_fails")
def baseline_after_opener_fails(ctx):
    with managed(ctx, "Calculator") as app:
        open_about(ctx, app)
        read = lambda: dialog_state(ctx, app)
        before = read()
        require(len(before) == 1, "one raw showing About dialog required before baseline")
        ctx.before("atspi.dialogs", before)
        response = ctx.product(["batch", json.dumps([
            {"command": "wait", "args": {"event": "surface-appeared", "app": "Calculator", "timeout": 1500}},
        ])])
        require(response.ok, response.raw)
        entries = (response.data or {}).get("results", [])
        require(len(entries) == 1 and entries[0].get("ok") is False, response.raw)
        require((entries[0].get("error") or {}).get("code") == "TIMEOUT", response.raw)
        ctx.after("atspi.dialogs", changed(read, before))
        ctx.restored("atspi.dialogs", read())
