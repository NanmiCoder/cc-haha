from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
import traceback
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS_ROOT))

TIER_CHOICES = ("x11-openbox", "x11-mutter", "wayland")
TIER_DEADLINE_S = 90.0
LEASE_FD_ENV = "AGENT_DESKTOP_INTERACTION_LEASE_FD"
SUITE_ENV = "AGENT_DESKTOP_E2E_SUITE"
LOCK_ROOT_ENV = "AGENT_DESKTOP_E2E_LOCK_ROOT"

_LEASE_FD: int | None = None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="run.sh")
    parser.add_argument("--tier", choices=TIER_CHOICES)
    parser.add_argument("--leg", help="one leg id or a comma-separated batch")
    parser.add_argument("--lying-actions", action="store_true")
    return parser.parse_args(argv)


def _load_helper(name: str):
    spec = importlib.util.spec_from_file_location(
        name, HARNESS_ROOT.parent / "e2e" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _acquire_lease(env: dict[str, str]) -> str | None:
    global _LEASE_FD
    interaction_lock = _load_helper("interaction_lock")
    lock_root = env.get(LOCK_ROOT_ENV)
    if lock_root:
        fd = interaction_lock.acquire(root=lock_root)
        if fd is None:
            return "the interaction lease is already held"
        _LEASE_FD = fd
        return None
    raw_fd = env.get(LEASE_FD_ENV)
    if raw_fd is None:
        return "run through run.sh so the interaction lease is held"
    try:
        interaction_lock.verify_inherited(int(raw_fd))
    except (ValueError, RuntimeError, OSError) as error:
        return f"the inherited interaction lease is not valid: {error}"
    return None


def _sigterm(_signum, _frame):
    raise SystemExit(128 + _signum)


def _write_lying_binary(suite_dir: Path) -> Path:
    path = Path(suite_dir) / "bin" / "agent-desktop"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('#!/bin/sh\nprintf \'{"ok":true,"data":{"headless":true}}\\n\'\n')
    path.chmod(0o500)
    return path


def _evidence_path(suite_dir: Path, tier: str, mode: str, leg_id: str) -> Path:
    return Path(suite_dir) / "evidence" / tier / mode / f"{leg_id}.json"


def _write_evidence(path: Path, ctx, outcome) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "leg": outcome.leg_id,
        "tier": outcome.tier,
        "mode": outcome.mode,
        "outcome": outcome.outcome,
        "detail": outcome.detail,
        "elapsed_ms": outcome.elapsed_ms,
        "exception_traceback": ctx.exception_traceback,
        "reads": ctx.reads,
        "findings": ctx.findings,
        "owned_baseline": sorted(ctx.baseline.members),
        "owned_final": sorted(ctx.owned().members),
        "products": [
            {
                "argv": envelope.argv,
                "ok": envelope.ok,
                "error": envelope.error,
                "elapsed_ms": envelope.elapsed_ms,
                "raw": envelope.raw[:4000],
            }
            for envelope in ctx.products
        ],
    }
    path.write_text(json.dumps(record, indent=2, default=repr))


def _recover_failed_members(ctx) -> None:
    from runner import session

    remaining = ctx.owned().members - ctx.baseline.members
    for signum in (signal.SIGTERM, signal.SIGKILL):
        for pid, start in sorted(remaining):
            if ((pid, start) in ctx.owned().members
                    and session._process_start_time(Path("/proc") / str(pid)) == start):
                session._kill(pid, signum, start, ctx.tier.runtime_dir, Path("/proc"))
        deadline = time.monotonic() + 1.0
        remaining = ctx.owned().members - ctx.baseline.members
        while remaining and time.monotonic() < deadline:
            time.sleep(0.05)
            remaining = ctx.owned().members - ctx.baseline.members
        if not remaining:
            return
    ctx.finding(f"failed-leg recovery left owned processes: {sorted(remaining)}")


def _run_leg(impl, leg, tier_obj, tier_name: str, mode: str, suite_dir: Path, verdict, report):
    from runner.session import TierUnavailable
    from runner.verdict import LegContext

    ctx = LegContext(tier_obj, mode, leg)
    started = time.perf_counter()
    outcome = report.PASS
    detail = ""
    try:
        impl(ctx)
        failures = verdict.evaluate(ctx)
        if failures:
            outcome = report.FAIL
            detail = "; ".join(failures)
    except TierUnavailable:
        raise
    except NotImplementedError as error:
        outcome = report.BLOCKED
        detail = str(error)
    except AssertionError as error:
        outcome = report.FAIL
        detail = str(error)
        ctx.exception_traceback = traceback.format_exc()
    except Exception as error:
        outcome = report.ERROR
        detail = f"{type(error).__name__}: {error}"
        ctx.exception_traceback = traceback.format_exc()
    elapsed = (time.perf_counter() - started) * 1000.0
    result = report.LegOutcome(
        leg_id=leg.id,
        tier=tier_name,
        mode=mode,
        outcome=outcome,
        detail=detail,
        elapsed_ms=elapsed,
    )
    try:
        _write_evidence(
            _evidence_path(suite_dir, tier_name, mode, leg.id), ctx, result
        )
    except OSError as error:
        result.outcome = report.ERROR
        ctx.finding(f"evidence could not be written: {error}")
    if result.outcome != report.PASS:
        try:
            _recover_failed_members(ctx)
        except OSError as error:
            ctx.finding(f"failed-leg recovery could not finish: {error}")
    result.findings = tuple(ctx.findings)
    return result


def _run_tier(tier_name: str, legs_for_tier, impls, suite_dir: Path, verify_binary: bool):
    from runner import apps, readiness, report, session, stage, verdict

    outcomes = [report.LegOutcome(leg.id, tier_name, mode, leg.disposition, leg.reason)
                for leg in legs_for_tier
                if leg.disposition in (report.OUTSTANDING, report.OWNER)
                for mode in leg.modes]
    legs_for_tier = [leg for leg in legs_for_tier
                     if leg.disposition not in (report.OUTSTANDING, report.OWNER)]
    if not legs_for_tier:
        return outcomes
    try:
        with session.start_tier(tier_name, TIER_DEADLINE_S) as tier_obj:
            try:
                readiness.wait_ready(tier_obj)
                apps.prime_desktop(tier_obj)
            except (OSError, AssertionError, RuntimeError) as error:
                raise session.TierUnavailable(f"{tier_name}: desktop warm-up failed: {error}") from error
            for leg in legs_for_tier:
                impl = impls.get(leg.id)
                for mode in leg.modes:
                    readiness.wait_ready(tier_obj)
                    if impl is None:
                        outcomes.append(
                            report.LegOutcome(
                                leg_id=leg.id,
                                tier=tier_name,
                                mode=mode,
                                outcome=report.UNIMPLEMENTED,
                            )
                        )
                        continue
                    outcomes.append(
                        _run_leg(impl, leg, tier_obj, tier_name, mode, suite_dir, verdict, report)
                    )
                if (
                    verify_binary
                    and impl is not None
                    and not stage.verify_staged(
                        Path(os.environ["AGENT_DESKTOP_E2E_BIN"]), suite_dir
                    )
                ):
                    outcomes.append(
                        report.LegOutcome(
                            leg_id="__staged_binary__",
                            tier=tier_name,
                            mode=leg.modes[-1],
                            outcome=report.ERROR,
                            detail="the staged binary changed during the run",
                        )
                    )
                    break
    except session.TierUnavailable as error:
        completed = {(row.leg_id, row.mode) for row in outcomes}
        for leg in legs_for_tier:
            for mode in leg.modes:
                if (leg.id, mode) in completed:
                    continue
                outcomes.append(
                    report.LegOutcome(
                        leg_id=leg.id,
                        tier=tier_name,
                        mode=mode,
                        outcome=report.TIER_UNAVAILABLE,
                        detail=str(error),
                    )
                )
    except session.TeardownError as error:
        outcomes.append(
            report.LegOutcome(
                leg_id="__teardown__",
                tier=tier_name,
                mode="teardown",
                outcome=report.ERROR,
                detail=str(error),
            )
        )
    return outcomes


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    import scenarios
    from runner import gate, legs, report, session, stage, verdict

    tiers = (args.tier,) if args.tier else TIER_CHOICES
    selected_ids = ({name.strip() for name in args.leg.split(",")} if args.leg
                    else {leg.id for leg in legs.REGISTRY})
    for leg_id in sorted(selected_ids):
        try:
            selected = legs.leg_by_id(leg_id)
        except KeyError:
            print(f"gate: unknown leg {leg_id}", file=sys.stderr)
            return report.exit_code(0, True)
        if args.leg and not set(selected.tiers).intersection(tiers):
            print(f"gate: {leg_id} is not registered for {args.tier}", file=sys.stderr)
            return report.exit_code(0, True)
    env = dict(os.environ)
    lease_problem = _acquire_lease(env)
    if lease_problem:
        print(f"gate: {lease_problem}", file=sys.stderr)
        return report.exit_code(0, True)
    missing = gate.check_prerequisites(tiers)
    if missing:
        for item in missing:
            print(f"gate: {item}", file=sys.stderr)
        return report.exit_code(0, True)

    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGHUP, _sigterm)

    suite_dir = Path(env.get(SUITE_ENV) or tempfile.mkdtemp(prefix="ad-e2e-suite-"))
    suite_dir.mkdir(parents=True, exist_ok=True)
    os.environ[SUITE_ENV] = str(suite_dir)

    if args.lying_actions:
        binary = _write_lying_binary(suite_dir)
    else:
        source = Path(
            env.get("AGENT_DESKTOP_E2E_BIN_SRC")
            or env.get("AGENT_DESKTOP_E2E_BIN")
            or session.HARNESS_ROOT.parent.parent / "target" / "release" / "agent-desktop"
        )
        try:
            binary = stage.stage_binary(source, suite_dir)
        except (OSError, RuntimeError, stage.StagedBinaryModified) as error:
            print(f"gate: {error}", file=sys.stderr)
            return report.exit_code(0, True)
    os.environ["AGENT_DESKTOP_E2E_BIN"] = str(binary)

    session_base = Path(
        env.get("AGENT_DESKTOP_SESSION_BASE")
        or (Path(env["XDG_RUNTIME_DIR"]) / "agent-desktop-sessions"
            if env.get("XDG_RUNTIME_DIR") else Path(f"/tmp/agent-desktop-sessions-{os.getuid()}"))
    )
    session.sweep_strays(session_base)

    impls = legs.implementations()
    outcomes = []
    for tier_name in tiers:
        legs_for_tier = [
            leg for leg in legs.REGISTRY if leg.id in selected_ids and tier_name in leg.tiers
        ]
        if not legs_for_tier:
            continue
        outcomes.extend(
            _run_tier(
                tier_name, legs_for_tier, impls, suite_dir, not args.lying_actions
            )
        )

    report_path = Path(suite_dir) / "report.txt"
    text = report.render(outcomes)
    try:
        report_path.write_text(text + "\n")
    except OSError:
        pass
    print(text)

    failures = report.count_failures(outcomes)
    if failures == 0:
        if not session._remove_tree(suite_dir):
            print(f"warn: the suite directory was retained: {suite_dir}", file=sys.stderr)
    else:
        print(f"evidence retained at {suite_dir}", file=sys.stderr)
    return report.exit_code(failures, False)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
