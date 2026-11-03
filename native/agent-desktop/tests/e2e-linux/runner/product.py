from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from runner.session import HARNESS_ROOT, Tier, _load_bounded_process

BINARY_ENV = "AGENT_DESKTOP_E2E_BIN"
LEASE_FD_ENV = "AGENT_DESKTOP_INTERACTION_LEASE_FD"
DEFAULT_BINARY = HARNESS_ROOT.parent.parent / "target" / "release" / "agent-desktop"
MAX_CAPTURE = 1_048_576


@dataclass
class Envelope:
    ok: bool
    data: dict | None
    error: dict | None
    raw: str
    elapsed_ms: float
    argv: list[str]
    exit_code: int | None = None


def _binary_path() -> str:
    return os.environ.get(BINARY_ENV) or str(DEFAULT_BINARY)


def _full_argv(binary: str, argv: list[str], headed: bool, window_id: str | None) -> list[str]:
    full = [binary]
    if headed:
        full.append("--headed")
    full += argv
    if window_id:
        full += ["--window-id", window_id]
    return full


def _result_env(tier: Tier) -> dict[str, str]:
    env = dict(tier.env)
    env.setdefault("HOME", str(Path.home()))
    env.setdefault("LANG", "C.UTF-8")
    if LEASE_FD_ENV in os.environ:
        env[LEASE_FD_ENV] = os.environ[LEASE_FD_ENV]
    return env


def _harness_error(code: str, message: str, raw: str, elapsed_ms: float, argv: list[str]) -> Envelope:
    return Envelope(
        ok=False,
        data=None,
        error={"code": code, "message": message},
        raw=raw,
        elapsed_ms=elapsed_ms,
        argv=list(argv),
    )


def _parse_envelope(stdout: str) -> dict | None:
    try:
        value = json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("ok"), bool):
        return None
    return value


def run_product(
    tier: Tier,
    argv: list[str],
    headed: bool = False,
    timeout_s: float = 30.0,
    window_id: str | None = None,
) -> Envelope:
    bounded = _load_bounded_process()
    binary = _binary_path()
    full_argv = _full_argv(binary, list(argv), headed, window_id)
    result = bounded.run_bounded(
        full_argv,
        timeout_seconds=timeout_s,
        max_capture_bytes=MAX_CAPTURE,
        env=_result_env(tier),
        inherit_interaction_lease=True,
    )
    elapsed = result.wall_ms
    raw = result.stdout
    stderr = result.stderr
    if result.termination_error:
        stderr = f"{stderr}\n{result.termination_error}"
    if result.timed_out:
        return _harness_error(
            "HARNESS_TIMEOUT",
            f"the product did not answer within {timeout_s}s",
            raw + stderr,
            elapsed,
            full_argv,
        )
    if result.output_limited:
        return _harness_error(
            "HARNESS_OUTPUT_LIMIT",
            f"the product wrote more than {MAX_CAPTURE} bytes",
            raw + stderr,
            elapsed,
            full_argv,
        )
    envelope = _parse_envelope(raw)
    if envelope is None:
        return _harness_error(
            "HARNESS_MALFORMED_ENVELOPE",
            f"stdout is not one JSON envelope (exit {result.returncode})",
            raw + stderr,
            elapsed,
            full_argv,
        )
    if result.returncode != (0 if envelope["ok"] else 1):
        return _harness_error(
            "HARNESS_EXIT_MISMATCH",
            f"exit {result.returncode} contradicts envelope ok={envelope['ok']}",
            raw + stderr,
            elapsed,
            full_argv,
        )
    return Envelope(
        ok=envelope["ok"],
        data=envelope.get("data"),
        error=envelope.get("error"),
        raw=raw,
        elapsed_ms=elapsed,
        argv=full_argv,
        exit_code=result.returncode,
    )
