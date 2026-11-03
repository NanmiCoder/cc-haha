from __future__ import annotations

from dataclasses import dataclass

PASS = "pass"
REFUSED = "asserted-refusal"
OWNER = "owner-decision"
OUTSTANDING = "outstanding"
BLOCKED = "blocked"
UNIMPLEMENTED = "unimplemented"
FAIL = "fail"
ERROR = "error"
TIER_UNAVAILABLE = "tier-unavailable"

_NONFAILING = {PASS, REFUSED}


@dataclass
class LegOutcome:
    leg_id: str
    tier: str
    mode: str
    outcome: str
    detail: str = ""
    findings: tuple[str, ...] = ()
    elapsed_ms: float = 0.0


def exit_code(failures: int, gate_failed: bool) -> int:
    if gate_failed:
        return 2
    return 1 if failures else 0


def count_failures(outcomes: list[LegOutcome]) -> int:
    return sum(1 for outcome in outcomes if outcome.outcome not in _NONFAILING)


def render(outcomes: list[LegOutcome]) -> str:
    lines = []
    tiers = sorted({outcome.tier for outcome in outcomes})
    for tier in tiers:
        lines.append(f"tier {tier}")
        for mode in ("headless", "headed"):
            rows = [
                outcome
                for outcome in outcomes
                if outcome.tier == tier and outcome.mode == mode
            ]
            if not rows:
                continue
            lines.append(f"  {mode}")
            for outcome in sorted(rows, key=lambda row: row.leg_id):
                line = f"    {outcome.outcome:<16} {outcome.leg_id}"
                if outcome.detail:
                    line = f"{line}  -- {outcome.detail}"
                lines.append(line)
                for finding in outcome.findings:
                    lines.append(f"      finding: {finding}")
    counts: dict[str, int] = {}
    for outcome in outcomes:
        counts[outcome.outcome] = counts.get(outcome.outcome, 0) + 1
    summary = ", ".join(f"{name} {counts[name]}" for name in sorted(counts))
    lines.append(f"summary: {summary or 'no legs ran'}")
    return "\n".join(lines)
