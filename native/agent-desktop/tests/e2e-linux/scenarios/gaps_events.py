import json

from oracle import atspi_raw as raw, proc, x11
from runner import apps
from runner.helper import changed, managed, ref, require
from scenarios.launch import _close_added_windows, _window_ids
from runner.legs import REGISTRY, implementation

TOKENS = ("window-opened", "window-closed", "app-launched", "app-terminated", "focus-changed")


def batch_wait(ctx, token, scoped, action, app="Calculator"):
    args = {"event": token, "timeout": 8000}
    if scoped:
        args["app"] = app
    response = ctx.product(["batch", json.dumps([
        action, {"command": "wait", "args": args}])])
    require(response.ok, response.raw)
    results = (response.data or {}).get("results", [])
    require(len(results) == 2 and all(item.get("ok") is True for item in results), response.raw)
    event = (results[-1].get("data") or {}).get("event") or {}
    expected_kind = "focus_changed_window" if token == "focus-changed" else token.replace("-", "_")
    require(event.get("kind") == expected_kind, response.raw)
    return event


def inventory(ctx):
    return sorted((app.name, len(app.windows)) for app in apps.owners_named(ctx.tier, "Calculator"))


def calculator_processes(ctx):
    return sum(name.startswith("gnome-calcul") for _, _, name in proc.members(ctx.tier.runtime_dir))


def quiet(ctx, token, scoped):
    with managed(ctx, "Calculator"):
        read = (lambda: x11.active_window(ctx.tier)) if token == "focus-changed" else (lambda: inventory(ctx))
        before = read()
        ctx.before("x11.focus" if token == "focus-changed" else "atspi.inventory", before)
        argv = ["wait", "--event", token, "--timeout", "1500"]
        if scoped:
            argv += ["--app", "Calculator"]
        response = ctx.product(argv)
        require(not response.ok and (response.error or {}).get("code") == "TIMEOUT", response.raw)
        details = (response.error or {}).get("details") or {}
        counts = details.get("baseline_counts")
        require(details.get("kind") == "wait_timeout" and details.get("event") == token
                and isinstance(counts, dict)
                and all(type(counts.get(key)) is int and counts[key] >= 0
                        for key in ("apps", "windows", "surfaces"))
                and counts["apps"] > 0 and counts["windows"] > 0,
                "quiet wait timed out without an observed baseline for its event")
        channel = "x11.focus" if token == "focus-changed" else "atspi.inventory"
        after = read()
        ctx.after(channel, after)
        require(after == before, "quiet wait changed its independent baseline")
        ctx.restored(channel, read())


def launch_transition(ctx, token, scoped):
    before = inventory(ctx)
    require(before == [], "Calculator must be absent before launch")
    require(calculator_processes(ctx) == 0, "a Calculator process already exists")
    ctx.before("atspi.inventory", before)
    ctx.before("proc.calculator_count", calculator_processes(ctx))
    try:
        event = batch_wait(ctx, token, scoped, {"command": "launch", "args": {"app": "Calculator"}})
        require(raw.poll(lambda: inventory(ctx), 5), "launch added no independently observed frame")
        ctx.after("atspi.inventory", inventory(ctx))
        owner = raw.app_root(ctx.tier, "gnome-calculator")
        require(event.get("pid") == raw.owner_pid(owner), "launch event named another process")
        ctx.after("proc.calculator_count", changed(lambda: calculator_processes(ctx), 1))
    finally:
        if inventory(ctx):
            ctx.product(["close-app", "Calculator"])
        ctx.restored("atspi.inventory", changed(lambda: inventory(ctx), before, seconds=6))
        ctx.restored("proc.calculator_count", changed(lambda: calculator_processes(ctx), 0, seconds=6))


def close_transition(ctx, token, scoped):
    with managed(ctx, "Calculator") as app:
        before = inventory(ctx)
        require(before, "Calculator must have a frame")
        ctx.before("atspi.inventory", before)
        ctx.before("proc.calculator_count", calculator_processes(ctx))
        event = batch_wait(ctx, token, scoped, {"command": "close-app", "args": {"app": "Calculator"}})
        require(event.get("pid") == app.pid, "termination event named another process")
        ctx.after("atspi.inventory", changed(lambda: inventory(ctx), [], seconds=6))
        ctx.after("proc.calculator_count", changed(lambda: calculator_processes(ctx), 0, seconds=6))
        with managed(ctx, "Calculator"):
            ctx.restored("atspi.inventory", changed(lambda: inventory(ctx), before, seconds=6))
            ctx.restored("proc.calculator_count", changed(lambda: calculator_processes(ctx), 1))


def focus_transition(ctx, scoped):
    with managed(ctx, "Calculator") as app, managed(ctx, "Text Editor") as other:
        target = x11.xid(ctx.tier, app.windows[0])
        original = x11.xid(ctx.tier, other.windows[0])
        x11.restore_active(ctx.tier, original)
        ctx.before("x11.focus", x11.active_window(ctx.tier))
        try:
            event = batch_wait(ctx, "focus-changed", scoped,
                       {"command": "focus-window", "args": {"window_id": app.windows[0]}})
            require(event.get("window_id") == app.windows[0], "focus event named another window")
            ctx.after("x11.focus", changed(lambda: x11.active_window(ctx.tier), target, seconds=6))
        finally:
            ctx.restored("x11.focus", x11.restore_active(ctx.tier, original))


def transition(ctx, token, scoped):
    if token == "focus-changed":
        focus_transition(ctx, scoped)
    elif token.startswith("window-"):
        window_transition(ctx, token, scoped)
    elif token == "app-launched":
        launch_transition(ctx, token, scoped)
    else:
        close_transition(ctx, token, scoped)


def window_transition(ctx, token, scoped):
    with managed(ctx, "Text Editor", ("--new-window",)) as app:
        seed = _window_ids(ctx.tier)
        require(len(seed) == 1, "window event requires exactly one seed frame")
        read = lambda: (len(_window_ids(ctx.tier)), seed[0] in _window_ids(ctx.tier))
        extra = None
        try:
            if token == "window-closed":
                extra = apps.launch(ctx.tier, "Text Editor", ("--new-window",))
                added = set(_window_ids(ctx.tier)) - set(seed)
                require(len(added) == 1, "second launch added no unique frame")
                added_id = added.pop()
                from dataclasses import replace
                target = ref(ctx, replace(app, windows=[added_id]), role="button", name="Close")
                action = {"command": "click", "args": {"ref_id": target}}
            else:
                action = {"command": "launch", "args": {"app": "Text Editor", "args": ["--new-window"]}}
            before = read()
            ctx.before("atspi.editor_windows", before)
            event = batch_wait(ctx, token, scoped, action, "Text Editor")
            require(event.get("pid") == app.pid, "window event named another process")
            if token == "window-opened":
                added = set(_window_ids(ctx.tier)) - set(seed)
                require(len(added) == 1 and event.get("window_id") in added,
                        "window-opened event does not name the independently added frame")
                ctx.after("atspi.editor_windows", changed(read, (2, True)))
                _close_added_windows(ctx.tier, seed)
            else:
                require(event.get("window_id") == added_id, "closed event named another frame")
                ctx.after("atspi.editor_windows", changed(read, (1, True)))
                apps.launch(ctx.tier, "Text Editor", ("--new-window",))
            ctx.restored("atspi.editor_windows", changed(read, before))
        finally:
            _close_added_windows(ctx.tier, seed)


for _token in TOKENS:
    for _scope in ("scoped", "unscoped"):
        for _kind, _fn in (("success", transition), ("quiet", quiet)):
            _id = f"gaps.event_{_token}_{_scope}_{_kind}"
            for _candidate in (_id, _id + ".mutter_owner"):
                if _candidate in {leg.id for leg in REGISTRY}:
                    implementation(_candidate)(
                        lambda ctx, token=_token, scoped=_scope == "scoped", fn=_fn: fn(ctx, token, scoped))
