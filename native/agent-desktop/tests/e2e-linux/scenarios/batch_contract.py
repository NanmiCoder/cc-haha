import json

from runner.helper import activate, changed, command, display, managed, one, ref, require, root
from runner.legs import implementation
from runner.verdict import LegContext

MISSING_CODE = "STALE_REF"
STOPPED = {"reason": "stop_on_error", "index": 1}


def batch_verdict(data: dict, *, stop: bool) -> list[str]:
    results = data.get("results", [])
    expected = 2 if stop else 3
    if len(results) != expected:
        return [f"expected {expected} entries, got {len(results)}"]
    problems = []
    if results[0].get("ok") is not True:
        problems.append("entry 0 should have succeeded")
    failing = results[1]
    if failing.get("ok") is not False or (failing.get("error") or {}).get("code") != MISSING_CODE:
        problems.append(f"entry 1 should fail with {MISSING_CODE}: {failing}")
    if data.get("total_entries") != 3:
        problems.append(f"total_entries should be 3: {data.get('total_entries')}")
    if stop:
        if data.get("stopped") != STOPPED:
            problems.append(f"stopped marker wrong: {data.get('stopped')}")
        if data.get("completed_entries") != 2 or data.get("not_started_entries") != 1:
            problems.append("stop_on_error counters wrong")
    else:
        if results[2].get("ok") is not True:
            problems.append("entry 2 must still run without --stop-on-error")
        if "stopped" in data:
            problems.append("no stop marker expected without --stop-on-error")
        if data.get("completed_entries") != 3:
            problems.append("every entry should have completed without --stop-on-error")
    return problems


def _entries(seven: str, eight: str, missing: str) -> str:
    return json.dumps([{"command": "click", "args": {"ref_id": seven}},
                       {"command": "click", "args": {"ref_id": missing}},
                       {"command": "click", "args": {"ref_id": eight}}])


def _clear(tree, undo) -> None:
    for _ in range(8):
        shown = display(tree)
        if shown == "":
            return
        activate(undo)
        changed(lambda: display(tree), shown[:-1], seconds=2)
    require(display(tree) == "", "undo never emptied the display")


@implementation("batch_contract.entry_failure_and_stop_on_error")
def entry_failure_and_stop_on_error(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        seven, eight = (ref(ctx, app, role="button", name=name) for name in ("7", "8"))
        missing = seven.split(":", 1)[0] + ":e999999"
        entries = _entries(seven, eight, missing)
        undo = one(tree, role=43, name="Undo")
        ctx.before("atspi", display(tree))
        try:
            full = command(ctx, ["batch", entries], app).data
            problems = batch_verdict(full, stop=False)
            require(not problems, "; ".join(problems))
            changed(lambda: display(tree), "78")
            _clear(tree, undo)
            halted = command(ctx, ["batch", entries, "--stop-on-error"], app).data
            problems = batch_verdict(halted, stop=True)
            require(not problems, "; ".join(problems))
            changed(lambda: display(tree), "7")
            ctx.after("atspi", display(tree))
        finally:
            _clear(tree, undo)
            ctx.restored("atspi", display(tree))
