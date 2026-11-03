#!/usr/bin/env python3
import json
import os
import sys

from bounded_process import INHERIT_INTERACTION_LEASE_ENV, run_bounded


MAX_JSON_INPUT_BYTES = 4 * 1024 * 1024
def read_json():
    payload = sys.stdin.buffer.read(MAX_JSON_INPUT_BYTES + 1)
    if len(payload) > MAX_JSON_INPUT_BYTES:
        raise SystemExit("JSON input exceeds capture limit")
    return json.loads(payload)


def render(value):
    if isinstance(value, bool):
        print("True" if value else "False")
    elif value is None:
        print("")
    elif isinstance(value, (dict, list)):
        print(json.dumps(value, separators=(",", ":"), sort_keys=True))
    else:
        print(value)


def get_path(data, path):
    value = data
    for part in path.split("."):
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def find_node(node, name):
    if node.get("name") == name:
        return node
    for child in node.get("children", []):
        found = find_node(child, name)
        if found is not None:
            return found
    return None


def find_drill_anchor(node):
    if node.get("children_count") and node.get("ref_id"):
        return node["ref_id"]
    for child in node.get("children", []):
        found = find_drill_anchor(child)
        if found:
            return found
    return None


def command_get(path):
    try:
        render(get_path(read_json(), path))
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        print("")


def command_target():
    data = read_json()
    if data.get("ok") is not True:
        raise SystemExit(2)
    body = data.get("data", {})
    match = body.get("match")
    if not isinstance(match, dict):
        raise SystemExit(3)
    ref_id = match.get("ref_id")
    snapshot_id = body.get("snapshot_id")
    if not ref_id or not snapshot_id:
        raise SystemExit(4)
    print(f"{ref_id}\t{snapshot_id}")


def command_match_value():
    data = read_json()
    match = data.get("data", {}).get("match")
    if data.get("ok") is not True or not isinstance(match, dict) or "value" not in match:
        raise SystemExit(2)
    print("" if match["value"] is None else match["value"])


def command_delivered_mechanism():
    data = read_json()
    steps = data.get("data", {}).get("steps", [])
    delivered = [
        step.get("mechanism")
        for step in steps
        if isinstance(step, dict) and step.get("outcome") == "succeeded"
    ]
    if data.get("ok") is not True or not delivered or not delivered[0]:
        raise SystemExit(2)
    print(delivered[0])


def command_tree(name, mode):
    data = read_json()
    node = find_node(data.get("data", {}).get("tree", {}), name)
    if node is None:
        raise SystemExit(2)
    if mode == "ref":
        ref_id = node.get("ref_id")
        if not ref_id:
            raise SystemExit(3)
        print(ref_id)
        return
    if mode == "has-ref":
        render(bool(node.get("ref_id")))
        return
    bounds = node.get("bounds")
    if not isinstance(bounds, dict):
        raise SystemExit(4)
    if mode == "center":
        print(f"{bounds['x'] + bounds['width'] / 2},{bounds['y'] + bounds['height'] / 2}")
    else:
        y = bounds["y"] + bounds["height"] / 2
        print(f"{bounds['x'] + 20},{y} {bounds['x'] + bounds['width'] - 20},{y}")


def command_duplicate_ids(title):
    data = read_json()
    ids = [
        window.get("id")
        for window in data.get("data", [])
        if window.get("title") == title and window.get("id")
    ]
    if len(ids) != 2 or len(set(ids)) != 2:
        raise SystemExit(2)
    print("\t".join(ids))


def command_drill_anchor():
    anchor = find_drill_anchor(read_json().get("data", {}).get("tree", {}))
    if not anchor:
        raise SystemExit(2)
    print(anchor)


def command_window_focused(window_id):
    windows = read_json().get("data", [])
    match = next((window for window in windows if window.get("id") == window_id), None)
    if match is None:
        raise SystemExit(2)
    render(match.get("is_focused"))


def command_run(output_path, command):
    result = run_bounded(
        command,
        inherit_interaction_lease=os.environ.get(INHERIT_INTERACTION_LEASE_ENV) == "1",
    )
    payload = result.stdout if result.stdout.strip() else result.stderr
    with open(output_path, "w", encoding="utf-8") as output:
        output.write(payload)
    print(f"{result.returncode}\t{result.wall_ms:.1f}")


def command_exec(command):
    try:
        result = run_bounded(
            command,
            inherit_interaction_lease=os.environ.get(INHERIT_INTERACTION_LEASE_ENV) == "1",
        )
    except OSError as error:
        print(f"could not start command: {error}", file=sys.stderr)
        raise SystemExit(126) from error
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.timed_out:
        print("process group exceeded the absolute timeout", file=sys.stderr)
    if result.output_limited:
        print("process group exceeded the capture limit", file=sys.stderr)
    if result.termination_error:
        print(result.termination_error, file=sys.stderr)
    raise SystemExit(result.returncode)


def main():
    command = sys.argv[1]
    if command == "get":
        command_get(sys.argv[2])
    elif command == "target":
        command_target()
    elif command == "match-value":
        command_match_value()
    elif command == "delivered-mechanism":
        command_delivered_mechanism()
    elif command == "tree":
        command_tree(sys.argv[2], sys.argv[3])
    elif command == "duplicate-ids":
        command_duplicate_ids(sys.argv[2])
    elif command == "drill-anchor":
        command_drill_anchor()
    elif command == "window-focused":
        command_window_focused(sys.argv[2])
    elif command == "run":
        command_run(sys.argv[2], sys.argv[3:])
    elif command == "exec":
        command_exec(sys.argv[2:])
    else:
        raise SystemExit(f"unknown command: {command}")


if __name__ == "__main__":
    main()
