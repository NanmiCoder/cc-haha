from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from runner.session import Tier


def tool(tier: Tier, argv: list[str], *, timeout_s: float = 5.0) -> str:
    from oracle.atspi_raw import remaining_timeout

    name = "linux_oracle_bounded_process"
    if name not in sys.modules:
        path = Path(__file__).resolve().parents[2] / "e2e" / "bounded_process.py"
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    result = sys.modules[name].run_bounded(
        argv, timeout_seconds=remaining_timeout(timeout_s), max_capture_bytes=2 * 1024 * 1024,
        env=tier.env,
    )
    if result.returncode or result.termination_error:
        raise RuntimeError(f"{argv!r}: {result.returncode}: {result.stderr}")
    return result.stdout.strip()


def get(tier: Tier, schema: str, key: str) -> str:
    return tool(tier, ["gsettings", "get", schema, key])


def set(tier: Tier, schema: str, key: str, value: str) -> None:
    tool(tier, ["gsettings", "set", schema, key, value])
