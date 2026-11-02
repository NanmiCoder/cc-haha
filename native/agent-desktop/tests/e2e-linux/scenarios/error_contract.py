from oracle.proc import members
from runner.helper import command, display, managed, ref, require, root
from runner.legs import implementation
from runner.verdict import LegContext

SNAPSHOT_RECOVERY = "refresh_snapshot_then_retry_original"
CASES = (
    ("bare ref", ["click", "@e1"], "INVALID_ARGS", "snapshot-qualified", None),
    ("unknown snapshot", ["click", "@sdeadbeef:e1"], "SNAPSHOT_NOT_FOUND", "snapshot", SNAPSHOT_RECOVERY),
    ("unknown app", ["snapshot", "--app", "No Such App For Harness", "-i"], "APP_NOT_FOUND", "list-apps", None),
)


def envelope_verdict(label, envelope, code, suggestion_has, recovery) -> list[str]:
    problems = []
    error = envelope.error or {}
    if envelope.ok or error.get("code") != code:
        problems.append(f"{label}: expected {code}, got ok={envelope.ok} code={error.get('code')!r}")
    suggestion = error.get("suggestion")
    if not suggestion:
        problems.append(f"{label}: no suggestion for the agent")
    elif suggestion_has not in suggestion:
        problems.append(f"{label}: suggestion does not name {suggestion_has!r}")
    if (error.get("disposition") or {}).get("delivery") != "not_delivered":
        problems.append(f"{label}: a refused request must be reported not_delivered")
    if recovery is not None and (error.get("recovery") or {}).get("strategy") != recovery:
        problems.append(f"{label}: recovery strategy is not {recovery!r}")
    if envelope.exit_code != 1:
        problems.append(f"{label}: structured error must exit 1, got {envelope.exit_code}")
    return problems


@implementation("error_contract.recoverable_error_envelopes")
def recoverable_error_envelopes(ctx: LegContext) -> None:
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        ref(ctx, app, role="button", name="7")
        ctx.before("atspi.display", display(tree))
        ctx.before("proc.members", members(ctx.tier.runtime_dir))
        problems = []
        for label, argv, code, suggestion_has, recovery in CASES:
            envelope = command(ctx, argv, code=code)
            problems += envelope_verdict(label, envelope, code, suggestion_has, recovery)
        ctx.after("atspi.display", display(tree))
        ctx.after("proc.members", members(ctx.tier.runtime_dir))
        require(not problems, "; ".join(problems))
        ctx.restored("atspi.display", display(tree))
        ctx.restored("proc.members", members(ctx.tier.runtime_dir))
