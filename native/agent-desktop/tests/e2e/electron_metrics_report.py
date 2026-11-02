import datetime
import math
import platform
from collections import Counter


def percentile(values, quantile):
    ordered = sorted(values)
    index = max(0, math.ceil(quantile * len(ordered)) - 1)
    return ordered[index]


def metric_summary(values, unit):
    return {
        "unit": unit,
        "samples": len(values),
        "min": round(min(values), 3),
        "p50": round(percentile(values, 0.50), 3),
        "p95": round(percentile(values, 0.95), 3),
        "max": round(max(values), 3),
    }


def rate(count, total):
    return round(count / total, 6) if total else 0.0


def nested_number(sample, *path):
    value = sample.get("stats")
    for part in path:
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def optional_metric(samples, unit, *path):
    values = [nested_number(sample, *path) for sample in samples]
    available = [value for value in values if value is not None]
    result = {
        "available": bool(available),
        "available_samples": len(available),
        "total_samples": len(samples),
    }
    if available:
        result["summary"] = metric_summary(available, unit)
    return result


def summarize_run(identity, samples):
    attempts = len(samples)
    command_successes = sum(sample["command_success"] for sample in samples)
    addressable = sum(sample["addressable"] for sample in samples)
    exact = sum(sample["exact_reresolution"] for sample in samples)
    correct = sum(sample["correct"] for sample in samples)
    failures = Counter(
        sample["failure_kind"] for sample in samples if sample.get("failure_kind")
    )
    activation = [
        sample["stats"]["activation"]
        for sample in samples
        if isinstance(sample.get("stats"), dict)
        and isinstance(sample["stats"].get("activation"), dict)
    ]
    return {
        "binary": identity,
        "metrics": {
            "end_to_end_wall_all_attempts": metric_summary(
                [sample["wall_ms"] for sample in samples], "ms"
            ),
            "process_cpu_all_attempts": metric_summary(
                [sample["cpu_ms"] for sample in samples], "ms"
            ),
            "locator_internal": optional_metric(samples, "us", "elapsed_us"),
            "nodes_visited": optional_metric(
                samples, "nodes", "traversal", "nodes_visited"
            ),
            "peak_native_handles": optional_metric(
                samples, "handles", "traversal", "peak_handles_owned"
            ),
            "attribute_batches": optional_metric(
                samples, "batches", "reads", "attribute_batches"
            ),
            "attributes_requested": optional_metric(
                samples, "attributes", "reads", "attributes_requested"
            ),
            "cannot_complete": optional_metric(
                samples, "events", "reads", "cannot_complete"
            ),
            "deadline_exhausted": optional_metric(
                samples, "events", "reads", "deadline_exhausted"
            ),
        },
        "reliability": {
            "attempts": attempts,
            "command_successes": command_successes,
            "command_success_rate": rate(command_successes, attempts),
            "addressable_results": addressable,
            "addressable_result_rate": rate(addressable, attempts),
            "exact_reresolutions": exact,
            "exact_reresolution_rate": rate(exact, attempts),
            "correct_results": correct,
            "correct_result_rate": rate(correct, attempts),
            "failure_kinds": dict(sorted(failures.items())),
        },
        "activation": {
            "available_samples": len(activation),
            "attempted_runs": sum(bool(item.get("attempted")) for item in activation),
            "succeeded_runs": sum(bool(item.get("succeeded")) for item in activation),
            "ready_runs": sum(bool(item.get("ready")) for item in activation),
        },
        "samples": samples,
    }


def paired_summary(pairs):
    comparable = [
        pair
        for pair in pairs
        if pair["current"]["command_success"]
        and pair["baseline"]["command_success"]
    ]
    wall = [
        pair["current"]["wall_ms"] - pair["baseline"]["wall_ms"]
        for pair in comparable
    ]
    cpu = [
        pair["current"]["cpu_ms"] - pair["baseline"]["cpu_ms"]
        for pair in comparable
    ]
    current_only = sum(
        pair["current"]["correct"] and not pair["baseline"]["correct"]
        for pair in pairs
    )
    baseline_only = sum(
        pair["baseline"]["correct"] and not pair["current"]["correct"]
        for pair in pairs
    )
    result = {
        "paired_attempts": len(pairs),
        "comparable_successful_pairs": len(comparable),
        "orders": dict(sorted(Counter(pair["order"] for pair in pairs).items())),
        "correctness_discordance": {
            "current_only_correct": current_only,
            "baseline_only_correct": baseline_only,
        },
    }
    if comparable:
        result["current_minus_baseline"] = {
            "wall": metric_summary(wall, "ms"),
            "cpu": metric_summary(cpu, "ms"),
            "current_faster_wall_pairs": sum(value < 0 for value in wall),
            "current_faster_wall_rate": rate(sum(value < 0 for value in wall), len(wall)),
        }
    return result


def build_report(args, runs, pairs, state_reference):
    baseline = "baseline" in runs
    report = {
        "schema": "agent-desktop-electron-live-v3",
        "ok": True,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "app": args.app,
        "environment": {
            "platform": platform.platform(),
            "architecture": platform.machine(),
        },
        "method": {
            "operation": "release CLI find --app APP --window-id EXACT --role button --first",
            "warmup_pairs": args.warmups,
            "measured_pairs": args.samples,
            "order": "deterministic balanced AB/BA interleaving",
            "order_labels": "A=baseline, B=current",
            "percentile": "nearest-rank",
            "subprocess_timeout_seconds": args.timeout_seconds,
            "subprocess_capture_limit_bytes": args.capture_limit_bytes,
            "trace_limit_bytes": 16 * 1024 * 1024,
            "state_gate": "exact app process generation and window inventory before and after every pair",
            "exclusivity": "caller acknowledgement plus harness-only lock; unrelated automation is not mechanically excluded",
            "network_used": False,
            "app_mutations": "none; observation and renderer accessibility activation only",
            "cpu_scope": "per-command RUSAGE_CHILDREN user+system delta in a serial harness",
            "rss_reported": False,
        },
        "state_reference": state_reference,
        "comparison": {
            "baseline_provided": baseline,
            "commands_identical": True,
            "separate_homes": True,
            "immutable_binary_hashes": True,
        },
        "runs": {label: summarize_run(run["identity"], run["samples"]) for label, run in runs.items()},
        "limitations": [
            "Results describe this exact app state, machine, and TCC state; they are not a cross-machine benchmark.",
            "The harness measures locator reliability and exact ref re-resolution without click or text mutation.",
            "Locator-internal metrics are reported only for samples whose binary emitted valid query_stats.",
        ],
    }
    if baseline:
        report["paired_comparison"] = paired_summary(pairs)
    return report
