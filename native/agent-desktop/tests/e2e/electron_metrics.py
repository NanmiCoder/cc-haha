#!/usr/bin/env python3
import argparse
import dataclasses
import json
import os
import sys
import tempfile

from electron_metrics_common import MeasurementError, parse_envelope, sha256_file
from electron_metrics_report import build_report
from electron_metrics_state import assert_stable, capture_app_state
from json_tool import run_bounded


TRACE_LIMIT_BYTES = 16 * 1024 * 1024
HELPER_ENV = (
    "AGENT_DESKTOP_PERMISSION_HELPER",
    "AGENT_DESKTOP_PERMISSION_OPERATION",
    "AGENT_DESKTOP_PERMISSION_TOKEN",
    "AGENT_DESKTOP_PERMISSION_PARENT_PID",
    "AGENT_DESKTOP_PERMISSION_PARENT_INSTANCE",
    "AGENT_DESKTOP_PERMISSION_EXECUTABLE",
)


@dataclasses.dataclass
class Runner:
    label: str
    binary: str
    environment: dict
    identity: dict
    trace_path: str
    require_stats: bool
    trace_offset: int = 0


def isolated_environment(root, label):
    home = os.path.join(root, f"{label}-home")
    os.makedirs(home, exist_ok=True)
    environment = os.environ.copy()
    environment["HOME"] = home
    environment.pop("AGENT_DESKTOP_SESSION", None)
    for name in HELPER_ENV:
        environment.pop(name, None)
    return environment


def binary_identity(binary, environment, timeout, capture_limit):
    result = run_bounded(
        [binary, "version"], timeout_seconds=timeout,
        max_capture_bytes=capture_limit, env=environment,
        inherit_interaction_lease=True,
    )
    data = parse_envelope(result, "binary version identity").get("data", {})
    return {
        "path": os.path.abspath(binary),
        "sha256": sha256_file(binary),
        "version": data.get("version"),
        "target": data.get("target"),
    }


def create_runner(label, binary, args, require_stats):
    environment = isolated_environment(args.work_root, label)
    descriptor, trace_path = tempfile.mkstemp(
        prefix=f"agentdesk-{label}-", suffix=".jsonl", dir=args.work_root
    )
    os.close(descriptor)
    return Runner(
        label=label,
        binary=binary,
        environment=environment,
        identity=binary_identity(
            binary, environment, args.timeout_seconds, args.capture_limit_bytes
        ),
        trace_path=trace_path,
        require_stats=require_stats,
    )


def read_trace_events(path, offset):
    size = os.path.getsize(path)
    if size > TRACE_LIMIT_BYTES:
        raise MeasurementError("measurement trace exceeded 16 MiB")
    if size < offset:
        raise MeasurementError("measurement trace was truncated during the run")
    events = []
    with open(path, "r", encoding="utf-8") as trace:
        trace.seek(offset)
        for line_number, line in enumerate(trace, 1):
            try:
                event = json.loads(line)
            except json.JSONDecodeError as error:
                raise MeasurementError(
                    f"measurement trace contained malformed JSON at appended line {line_number}"
                ) from error
            if not isinstance(event, dict):
                raise MeasurementError("measurement trace contained a non-object event")
            events.append(event)
        return events, trace.tell()


def newest_locator_stats(events):
    for event in reversed(events):
        stats = event.get("query_stats")
        if event.get("event") == "locator.resolve" and isinstance(stats, dict):
            return stats, event
    return None, None


def command_failure(result):
    if result.termination_error:
        return "termination_failure", result.termination_error
    if result.timed_out:
        return "timeout", None
    if result.output_limited:
        return "output_limit", None
    payload = result.stdout if result.stdout.strip() else result.stderr
    try:
        envelope = json.loads(payload)
    except json.JSONDecodeError:
        return "malformed_output", None
    if not isinstance(envelope, dict):
        return "invalid_envelope", None
    if result.returncode != 0 or envelope.get("ok") is not True:
        return "command_error", envelope.get("error", {}).get("code")
    return None, envelope


def verify_exact_namespace(runner, args, window_id, sample):
    noise = run_bounded(
        [runner.binary, "find", "--app", args.app, "--window-id", window_id,
         "--role", "button", "--last"],
        timeout_seconds=args.timeout_seconds,
        max_capture_bytes=args.capture_limit_bytes,
        env=runner.environment,
        inherit_interaction_lease=True,
    )
    try:
        noise_body = parse_envelope(noise, f"{runner.label} namespace-overwrite find")["data"]
        noise_snapshot = noise_body.get("snapshot_id")
        if not noise_snapshot or noise_snapshot == sample["snapshot_id"]:
            return False
        resolved = run_bounded(
            [runner.binary, "get", sample["ref_id"], "--property", "role"],
            timeout_seconds=args.timeout_seconds,
            max_capture_bytes=args.capture_limit_bytes,
            env=runner.environment,
            inherit_interaction_lease=True,
        )
        role = parse_envelope(resolved, f"{runner.label} exact snapshot re-resolution")
        data = role.get("data", {})
        return data.get("property") == "role" and data.get("value") == sample["role"]
    except (KeyError, MeasurementError):
        return False


def run_sample(runner, args, window_id):
    result = run_bounded(
        [runner.binary, "--trace", runner.trace_path, "find", "--app", args.app,
         "--window-id", window_id, "--role", "button", "--first"],
        timeout_seconds=args.timeout_seconds,
        max_capture_bytes=args.capture_limit_bytes,
        env=runner.environment,
        inherit_interaction_lease=True,
    )
    events, runner.trace_offset = read_trace_events(runner.trace_path, runner.trace_offset)
    stats, trace_event = newest_locator_stats(events)
    failure_kind, envelope = command_failure(result)
    if runner.require_stats and stats is None and failure_kind is None:
        raise MeasurementError("current successful find trace omitted locator.resolve query_stats")
    sample = {
        "wall_ms": round(result.wall_ms, 3),
        "cpu_ms": round(result.cpu_ms, 3),
        "command_success": failure_kind is None,
        "addressable": False,
        "exact_reresolution": False,
        "correct": False,
        "failure_kind": failure_kind,
        "error_code": None,
        "stats": stats,
    }
    if failure_kind:
        sample["error_code"] = envelope
        return sample
    body = envelope.get("data", {})
    match = body.get("match")
    if not isinstance(match, dict) or not match.get("ref_id") or not body.get("snapshot_id"):
        sample["failure_kind"] = "not_addressable"
        return sample
    sample.update({
        "addressable": True,
        "ref_id": match["ref_id"],
        "snapshot_id": body["snapshot_id"],
        "role": match.get("role"),
    })
    sample["exact_reresolution"] = verify_exact_namespace(
        runner, args, window_id, sample
    )
    complete = trace_event is None or trace_event.get("complete") is True
    sample["correct"] = sample["exact_reresolution"] and complete
    if not sample["correct"]:
        sample["failure_kind"] = "incomplete_traversal" if not complete else "reresolution"
    for field in ("ref_id", "snapshot_id", "role"):
        sample.pop(field, None)
    return sample


def order_for(index, baseline):
    if not baseline:
        return ["current"]
    return ["baseline", "current"] if index % 2 == 0 else ["current", "baseline"]


def verify_binary_unchanged(runner):
    if runner.identity["sha256"] != sha256_file(runner.binary):
        raise MeasurementError(f"{runner.label} binary changed during measurement")


def ensure_distinct_comparison(runners):
    if "baseline" in runners and (
        runners["baseline"].identity["sha256"] == runners["current"].identity["sha256"]
    ):
        raise MeasurementError("baseline and current binaries have identical SHA-256 identities")


def execute_pair(index, runners, reference, args, warmup=False):
    probe = runners["current"]
    assert_stable(reference, capture_app_state(probe, args), "before pair")
    order = order_for(index, "baseline" in runners)
    samples = {}
    for position, label in enumerate(order):
        sample = run_sample(runners[label], args, reference["target_window_id"])
        sample["pair_index"] = index
        sample["order_position"] = position
        samples[label] = sample
        if warmup and not sample["command_success"]:
            raise MeasurementError(f"{label} warmup command failed")
    assert_stable(reference, capture_app_state(probe, args), "after pair")
    samples["order"] = "".join("A" if label == "baseline" else "B" for label in order)
    return samples


def measure(args):
    runners = {
        "current": create_runner(
            "current", args.binary, args, True
        )
    }
    if args.baseline_binary:
        runners["baseline"] = create_runner(
            "baseline", args.baseline_binary, args, False
        )
    try:
        ensure_distinct_comparison(runners)
        reference = capture_app_state(runners["current"], args)
        for index in range(args.warmups):
            execute_pair(index, runners, reference, args, warmup=True)
        pairs = []
        for index in range(args.samples):
            pair = execute_pair(index, runners, reference, args)
            pairs.append(pair)
            for label in runners:
                verify_binary_unchanged(runners[label])
        runs = {
            label: {"identity": runner.identity, "samples": [pair[label] for pair in pairs]}
            for label, runner in runners.items()
        }
        return build_report(args, runs, pairs, reference)
    finally:
        for runner in runners.values():
            try:
                os.unlink(runner.trace_path)
            except FileNotFoundError:
                pass


def write_report(path, report):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=os.path.dirname(os.path.abspath(path)),
            prefix=f".{os.path.basename(path)}.", delete=False,
        ) as output:
            temporary = output.name
            json.dump(report, output, indent=2, sort_keys=True)
            output.write("\n")
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--baseline-binary")
    parser.add_argument("--app", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--work-root", required=True)
    parser.add_argument("--warmups", type=int, default=5)
    parser.add_argument("--samples", type=int, default=31)
    parser.add_argument("--timeout-seconds", type=float, default=20)
    parser.add_argument("--capture-limit-bytes", type=int, default=2 * 1024 * 1024)
    args = parser.parse_args()
    if args.warmups < 0 or args.samples < 1:
        parser.error("--warmups must be non-negative and --samples must be positive")
    try:
        write_report(args.out, measure(args))
    except (MeasurementError, OSError, ValueError) as error:
        write_report(args.out, {
            "schema": "agent-desktop-electron-live-v3", "ok": False, "app": args.app,
            "error": {"kind": "measurement_failed", "message": str(error)},
        })
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
    print(os.path.abspath(args.out))


if __name__ == "__main__":
    main()
