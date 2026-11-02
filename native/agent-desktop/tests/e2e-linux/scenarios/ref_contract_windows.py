"""Dialog, chooser and top-level workflows with independent restoration."""

from uuid import uuid4

from oracle.atspi_raw import poll
from runner.helper import nodes, one, require, root
from scenarios.ref_contract import (BLOCKED, OPENERS, act, events, matching_event, named,
                                    print_rows, ref_nodes, reset, since_reset, snapshot, zoo)
from scenarios.ref_contract_identity import identify, raw_target

def window_state(tree):
    rows = []
    for node in tree.children():
        try:
            states = node.states
            if "SHOWING" in states:
                rows.append((node.name, node.role, "MODAL" in states))
        except Exception:
            if any((n.bus, n.path) == (node.bus, node.path) for n in tree.children()):
                raise
    return tuple(sorted(rows))


def raw_window(tree, title):
    # A top-level widget can expose its accessible name instead of its WM title.
    names = (title, "zoo-top-button") if title == "Zoo Top Button" else (title,)
    matches = [n for n in tree.children() if n.name in names and "SHOWING" in n.states]
    require(len(matches) <= 1, f"multiple raw windows for {title}")
    return matches[0] if matches else None


def surface_snapshot(ctx, app, title, modal):
    from runner.apps import window_id
    argv = ["snapshot", "-i", "--window-id", window_id(raw_window(root(ctx, app), title))]
    if modal:
        argv += ["--surface", "sheet"]
    response = ctx.product(argv, headed=False)
    require(response.data and response.data.get("complete") is True,
            f"incomplete {title} surface: {response.raw}")
    data = identify(ctx.tier.state_root, response.data)
    names = (title, "zoo-top-button") if title == "Zoo Top Button" else (title,)
    require(any(n.get("name") in names for n in nodes(data.get("tree", data))),
            f"snapshot did not reach {title}")
    return data


def window_listed(ctx, app, title):
    response = ctx.product(["list-windows"], headed=False)
    names = (title, "zoo-top-button") if title == "Zoo Top Button" else (title,)
    return any(n.get("title") in names and n.get("pid") == app.pid for n in nodes(response.data))


def dialog(ctx, app, tree, path, data):
    marker = "dialog-" + uuid4().hex
    start = len(events(path))
    entry = named(data, "zoo-dialog-entry")
    target = raw_target(tree, entry)
    act(ctx, entry, "type", marker)
    require(poll(lambda: matching_event(events(path)[start:], "zoo-dialog-entry", "changed", marker)
                 and target.text() == marker, 3),
            "dialog entry did not receive text in both oracles")
    data = surface_snapshot(ctx, app, "Zoo Dialog", True)
    act(ctx, named(data, ("zoo-dialog-ok", "OK"), "button"), "click")
    require(poll(lambda: matching_event(events(path)[start:], "zoo-dialog-ok", "activate", any_value=True)
                 and not any(name == "Zoo Dialog" for name, _, _ in window_state(tree)), 3),
            "dialog OK did not activate and close")


def chooser(ctx, app, tree, path, data, saved):
    # Native chooser labels differ; inactive panes can retain another name field.
    fields = [n for n in ref_nodes(data) if "TypeText" in n.get("available_actions", ())
              and not BLOCKED.intersection(n.get("states", ()))
              and n.get("name", "").strip().casefold().rstrip(":") in
              ("name", "file name", "filename")]
    require(len(fields) == 1, f"expected one save-name field: {fields}")
    target = raw_target(tree, fields[0])
    act(ctx, fields[0], "type", str(saved))
    require(poll(lambda: target.text() == str(saved), 3),
            "chooser name field did not receive the runtime path")
    data = surface_snapshot(ctx, app, "Zoo Save", True)
    buttons = [n for n in ref_nodes(data) if n.get("name", "").replace("_", "").casefold() in ("save", "zoo-save-ok")
               and "Click" in n.get("available_actions", ())]
    require(len(buttons) == 1, f"expected one Save button: {buttons}")
    start = len(events(path))
    act(ctx, buttons[0], "click")
    require(poll(lambda: matching_event(events(path)[start:], "zoo-open-chooser", "saved", str(saved))
                 and saved.is_file(), 4), "save produced neither the contracted event nor file")


def windows(ctx):
    rows = []
    try:
        with zoo(ctx) as (app, path):
            tree = root(ctx, app)
            openers = list(OPENERS) if ctx.leg.id.startswith("ref_contract.zoo_qt") else list(OPENERS)[:2]
            for index, opener in enumerate(openers):
                title = OPENERS[opener]
                row = dict(name=opener, role="button", states=[], action="click/window workflow",
                           expected="land", observed="", verdict="fail")
                rows.append(row)
                channel = f"window{index}"
                saved = ctx.tier.runtime_dir / f"zoo-save-{uuid4().hex}.txt"
                ctx.before("atspi." + channel, window_state(tree))
                ctx.before("applog." + channel, since_reset(path))
                try:
                    node = named(snapshot(ctx, app), opener)
                    row.update(role=node.get("role"), states=node.get("states", []))
                    require(raw_window(tree, title) is None, f"{title} already open before click")
                    act(ctx, node, "click")
                    require(poll(lambda: raw_window(tree, title), 4), f"no raw {title} window")
                    require(poll(lambda: window_listed(ctx, app, title), 3), f"list-windows missed {title}")
                    modal = opener != "zoo-open-toplevel-button"
                    if modal:
                        window = raw_window(tree, title)
                        require("MODAL" in window.states or window.role in (2, 16, 19),
                                f"{title} is neither a raw dialog nor MODAL")
                    data = surface_snapshot(ctx, app, title, modal)
                    if opener == "zoo-open-dialog":
                        dialog(ctx, app, tree, path, data)
                    elif opener == "zoo-open-chooser":
                        chooser(ctx, app, tree, path, data, saved)
                    else:
                        name = "OK" if opener == "zoo-open-message" else "zoo-top-button"
                        start = len(events(path))
                        act(ctx, named(data, name), "click")
                        if name == "OK":
                            require(poll(lambda: not any(name == title for name, _, _ in window_state(tree)), 3))
                        else:
                            require(poll(lambda: matching_event(events(path)[start:], name, "activate", any_value=True)
                                         and "SHOWING" in one(tree, name=name).states, 3))
                    row.update(observed=f"raw {title}, listed title, surface and effects verified", verdict="pass")
                except Exception as error:
                    row["observed"] = str(error)
                finally:
                    ctx.after("atspi." + channel, window_state(tree))
                    ctx.after("applog." + channel, since_reset(path))
                    reset(path)
                    snapshot(ctx, app)
                    restored = window_state(tree)
                    ctx.restored("atspi." + channel, restored)
                    ctx.restored("applog." + channel, since_reset(path))
                    before = ctx.reads["atspi." + channel]["before"][0]
                    if restored != before or since_reset(path):
                        row.update(verdict="fail", observed="reset did not restore the window baseline")
    finally:
        print_rows(ctx, rows)
    require(all(row["verdict"] == "pass" for row in rows), "window-contract table has failures")
