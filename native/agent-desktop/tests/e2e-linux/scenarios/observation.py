import json

from oracle import atspi_raw as raw
from oracle.proc import members
from runner import apps
from runner.helper import (activate, changed, command, delayed, display, managed,
                           nodes, one, ref, require, root, snapshot, remove)
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.menus import _toggle, _visible
from scenarios.surfaces import prepare_about

EXPECTED_STALE_CODE = "STALE_REF"
STALE_RECOVERY = "refresh_snapshot_then_retry_original"


def refs(data):
    return {item["ref_id"] for item in nodes(data) if isinstance(item.get("ref_id"), str)}


@implementation("observation.qualified_refs_survive_snapshots")
def qualified_refs_survive_snapshots(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        target = ref(ctx, app, role="button", name="7")
        tree = root(ctx, app)
        ctx.before("atspi", display(tree))
        with managed(ctx, "Files", (str(ctx.tier.runtime_dir),)) as other:
            snapshot(ctx, other)
            command(ctx, ["click", target], app)
            changed(lambda: display(tree), "7")
            ctx.after("atspi", display(tree))
        activate(one(tree, role=43, name="Undo"))
        changed(lambda: display(tree), "")
        ctx.restored("atspi", display(tree))


@implementation("observation.stale_ref_after_app_killed")
def stale_ref_after_app_killed(ctx: LegContext) -> None:
    baseline = members(ctx.tier.runtime_dir)
    ctx.before("atspi", [item.bus for item in raw.registry(ctx.tier)])
    app = apps.launch(ctx.tier, "Calculator")
    try:
        target = ref(ctx, app, role="button", name="7")
        apps.stop(app)
        require(raw.poll(lambda: app.owner_names[0] not in
                         [item.bus for item in raw.registry(ctx.tier)], 3),
                "dead owner remains registered")
        after = [item.bus for item in raw.registry(ctx.tier)]
        command(ctx, ["click", target, "--timeout-ms", "0"],
                code=("STALE_REF", "ELEMENT_NOT_FOUND"))
        require([item.bus for item in raw.registry(ctx.tier)] == after)
        ctx.after("atspi", after)
    finally:
        apps.stop(app)
        changed(lambda: members(ctx.tier.runtime_dir), baseline)
        ctx.restored("atspi", [item.bus for item in raw.registry(ctx.tier)])


def stale_verdict(envelope, display_before: str, display_after: str) -> list[str]:
    problems = []
    error = envelope.error or {}
    if envelope.ok or error.get("code") != EXPECTED_STALE_CODE:
        problems.append(f"expected {EXPECTED_STALE_CODE}, got ok={envelope.ok} code={error.get('code')!r}")
    if (error.get("disposition") or {}).get("delivery") != "not_delivered":
        problems.append("a stale ref must be reported not_delivered")
    if (error.get("recovery") or {}).get("strategy") != STALE_RECOVERY:
        problems.append(f"stale envelope recovery strategy is not {STALE_RECOVERY!r}")
    if envelope.exit_code != 1:
        problems.append(f"structured error must exit 1, got {envelope.exit_code}")
    if display_before != display_after:
        problems.append("a refused stale click changed the display")
    return problems


def close_main_menu(ctx, app) -> None:
    owner = app.owner_names[0]
    _toggle(ctx.tier, owner)
    require(raw.poll(lambda: not _visible(ctx.tier, owner), 4), "main menu did not close")


@implementation("observation.stale_ref_after_ui_change")
def stale_ref_after_ui_change(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        baseline = members(ctx.tier.runtime_dir)
        tree = root(ctx, app)
        shown = display(tree)
        ctx.before("atspi.display", shown)
        ctx.before("proc.members", baseline)
        target = prepare_about(ctx, app)
        close_main_menu(ctx, app)
        envelope = command(ctx, ["click", target, "--timeout-ms", "0"], app, code=EXPECTED_STALE_CODE)
        problems = stale_verdict(envelope, shown, display(tree))
        require(not problems, "; ".join(problems))
        require(members(ctx.tier.runtime_dir) == baseline, "a stale ref must not end the app")
        ctx.after("atspi.display", display(tree))
        ctx.after("proc.members", members(ctx.tier.runtime_dir))
        fresh = prepare_about(ctx, app)
        require(fresh != target, "a fresh snapshot must mint a new ref")
        close_main_menu(ctx, app)
        ctx.restored("atspi.display", display(tree))
        ctx.restored("proc.members", members(ctx.tier.runtime_dir))


def preferences_showing(tree) -> bool:
    return any("SHOWING" in node.states for node in tree.find(name="Preferences"))


@implementation("observation.selector_wait_resolves")
def selector_wait_resolves(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        owner = app.owner_names[0]
        require(not preferences_showing(tree), "the wait target must be absent before the wait begins")
        ctx.before("atspi", preferences_showing(tree))
        trigger = delayed(0.6, lambda: _toggle(ctx.tier, owner))
        try:
            response = command(ctx, ["snapshot", "-i", "--surface", "menu",
                                     "--wait-for", "menuitem:Preferences",
                                     "--wait-timeout", "5000"], app)
            trigger.join()
        finally:
            trigger.cancel()
        require(any(item.get("name") == "Preferences" for item in nodes(response.data)),
                "the wait returned without the late menu item")
        require(preferences_showing(tree), "the wait returned before the menu item showed")
        ctx.after("atspi", preferences_showing(tree))
        close_main_menu(ctx, app)
        changed(lambda: preferences_showing(tree), False)
        ctx.restored("atspi", preferences_showing(tree))
        command(ctx, ["snapshot", "-i", "--wait-for", "button:absent-desktop-target",
                      "--wait-timeout", "0"], app, code="TIMEOUT")


@implementation("observation.enabled_state_canonical_and_raw")
def enabled_state_canonical_and_raw(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        undo = one(tree, role=43, name="Undo")
        target = ref(ctx, app, role="button", name="Undo")
        ctx.before("atspi", "SENSITIVE" in undo.states)
        require("SENSITIVE" not in undo.states)
        require(command(ctx, ["is", target, "--property", "enabled"], app).data["result"] is False)
        try:
            activate(one(tree, role=43, name="7"))
            changed(lambda: "SENSITIVE" in undo.states, True)
            require(command(ctx, ["is", target, "--property", "enabled"], app).data["result"] is True)
            states = command(ctx, ["get", target, "--property", "states"], app).data["value"]
            require("disabled" not in states, f"live enabled target was projected disabled: {states!r}")
            ctx.after("atspi", "SENSITIVE" in undo.states)
        finally:
            activate(undo)
            changed(lambda: "SENSITIVE" in undo.states, False)
            ctx.restored("atspi", "SENSITIVE" in undo.states)


def session_start(ctx):
    return command(ctx, ["session", "start"]).data["session_id"]


@implementation("observation.session_namespace_isolation")
def session_namespace_isolation(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        ctx.before("atspi", display(tree))
        first, second = session_start(ctx), session_start(ctx)
        try:
            data = command(ctx, ["--session", first, "snapshot", "-i"], app).data
            target = next(item["ref_id"] for item in nodes(data)
                          if item.get("name") == "7" and item.get("ref_id"))
            command(ctx, ["--session", second, "get", target],
                    code=("SNAPSHOT_NOT_FOUND", "STALE_REF"))
            require(command(ctx, ["--session", first, "get", target]).data["value"] == "7")
            require(display(tree) == "")
            ctx.after("atspi", display(tree))
        finally:
            for session in (first, second):
                command(ctx, ["session", "end", session])
                remove(ctx.tier.state_root / "sessions" / session)
            ctx.restored("atspi", display(tree))


@implementation("observation.trace_segment_written")
def trace_segment_written(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        session = session_start(ctx)
        directory = ctx.tier.state_root / "sessions" / session / "trace"
        before = set(directory.glob("*.jsonl"))
        ctx.before("proc", sorted(str(path) for path in before))
        try:
            command(ctx, ["--session", session, "snapshot", "-i"], app)
            added = set(directory.glob("*.jsonl")) - before
            require(len(added) == 1, f"expected one new trace segment: {added}")
            rows = [json.loads(line) for line in added.pop().read_text().splitlines()]
            require(rows and any("snapshot" in json.dumps(row) for row in rows))
            ctx.after("proc", rows)
        finally:
            command(ctx, ["session", "end", session])
            remove(ctx.tier.state_root / "sessions" / session)
            ctx.restored("proc", sorted(str(path) for path in directory.glob("*.jsonl")))
