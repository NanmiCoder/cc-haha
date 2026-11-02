#!/usr/bin/env python3
import json
import re
import sys


MAX_JSON_BYTES = 4 * 1024 * 1024
FIXTURE_WINDOW_TITLE = "AgentDesk Fixture"
SNAPSHOT_TOKEN = r"[A-Za-z0-9][A-Za-z0-9_-]{2,63}"
REF_PATTERN = re.compile(rf"^@{SNAPSHOT_TOKEN}:e[1-9][0-9]*$")
SNAPSHOT_PATTERN = re.compile(rf"^{SNAPSHOT_TOKEN}$")
SAFE_NAMED_TARGETS = {
    ("button", "primary-button"),
    ("textfield", "text-input"),
    ("textfield", "silent-text-input"),
    ("checkbox", "toggle-box"),
}
SAFE_STATUS_IDS = {
    ("statictext", "click-status"),
    ("statictext", "text-echo"),
    ("statictext", "toggle-status"),
}


class SafetyError(ValueError):
    pass


def _load_json_bytes(payload):
    if len(payload) > MAX_JSON_BYTES:
        raise SafetyError("JSON input exceeds the safety limit")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SafetyError(f"invalid JSON: {error}") from error
    if not isinstance(value, dict) or value.get("ok") is not True:
        raise SafetyError("command did not return an ok:true envelope")
    if "data" not in value:
        raise SafetyError("command envelope has no data")
    return value["data"]


def load_envelope_stream(stream):
    return _load_json_bytes(stream.buffer.read(MAX_JSON_BYTES + 1))


def load_envelope_file(path):
    with open(path, "rb") as source:
        return _load_json_bytes(source.read(MAX_JSON_BYTES + 1))


def _positive_pid(value, field):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SafetyError(f"{field} must be a positive PID")
    return value


def _required_text(item, field):
    value = item.get(field)
    if not isinstance(value, str) or not value:
        raise SafetyError(f"{field} must be a nonempty string")
    return value


def frontmost_identity(data):
    if not isinstance(data, list):
        raise SafetyError("list-windows data must be an array")
    focused = [window for window in data if window.get("is_focused") is True]
    if len(focused) != 1:
        raise SafetyError("frontmost window identity is missing or ambiguous")
    window = focused[0]
    if window.get("visible") is not True or window.get("minimized") is True:
        raise SafetyError("frontmost window is not a visible, non-minimized surface")
    return {
        "pid": _positive_pid(window.get("pid"), "frontmost pid"),
        "process_instance": _required_text(window, "process_instance"),
        "window_id": _required_text(window, "id"),
    }


def non_fixture_frontmost_identity(data, fixture_pid):
    identity = frontmost_identity(data)
    if identity["pid"] == fixture_pid:
        raise SafetyError("owned fixture unexpectedly became frontmost")
    return identity


def fixture_window_identity(windows_data, expected_app, expected_pid):
    if not isinstance(windows_data, list):
        raise SafetyError("list-windows data must be an array")
    owned_windows = [
        window
        for window in windows_data
        if isinstance(window.get("app_name"), str)
        and window["app_name"].casefold() == expected_app.casefold()
        and window.get("pid") == expected_pid
    ]
    exact_windows = [
        window
        for window in owned_windows
        if window.get("visible") is True and window.get("minimized") is not True
    ]
    if len(exact_windows) != 1:
        raise SafetyError("fixture actionable surface ownership is missing or ambiguous")
    window = exact_windows[0]
    if window.get("title") != FIXTURE_WINDOW_TITLE:
        raise SafetyError("fixture window title does not match the owned test surface")
    instance = _required_text(window, "process_instance")
    if window.get("is_focused") is not False:
        raise SafetyError("fixture unexpectedly became frontmost")
    return {
        "app_name": window["app_name"],
        "pid": expected_pid,
        "process_instance": instance,
        "window_id": _required_text(window, "id"),
        "window_title": window["title"],
    }


def _validate_timeout(raw):
    if not raw.isdecimal() or not 1 <= int(raw) <= 5_000:
        raise SafetyError("action timeout must be between 1 and 5000 milliseconds")


def _validate_ref_action_tail(argv, positional_count):
    expected_length = positional_count + 2
    if len(argv) != expected_length:
        raise SafetyError("ref action arguments do not match the safe contract")
    if not REF_PATTERN.fullmatch(argv[1]):
        raise SafetyError("ref action requires a qualified element ref")
    tail = argv[positional_count:]
    if tail[0] != "--timeout-ms":
        raise SafetyError("ref action requires an explicit bounded timeout")
    _validate_timeout(tail[1])


def validate_command(argv, fixture_app, window_id, mutation_armed):
    if not argv:
        raise SafetyError("empty command")
    if "--headed" in argv:
        raise SafetyError("headed mode is forbidden in the safe semantic suite")
    command = argv[0]
    if command in {"version", "permissions"}:
        if len(argv) != 1:
            raise SafetyError(f"{command} accepts no arguments in this suite")
        return
    if command == "list-windows":
        if argv not in (["list-windows"], ["list-windows", "--app", fixture_app]):
            raise SafetyError("list-windows must be global or fixture-scoped")
        return
    if command == "get":
        if not window_id or len(argv) != 4 or not REF_PATTERN.fullmatch(argv[1]) \
                or argv[2:] != ["--property", "value"]:
            raise SafetyError("get requires a qualified fixture value target")
        return
    if command == "find":
        if not window_id:
            raise SafetyError("find requires the exact owned fixture window")
        if len(argv) != 12 or argv[:6] != [
            "find", "--app", fixture_app, "--window-id", window_id, "--role",
        ] or argv[9:] != ["--exact", "--limit", "2"]:
            raise SafetyError("find is not an exact, unique, fixture-owned safe target query")
        target = (argv[6], argv[8])
        if not (
            argv[7] == "--name" and target in SAFE_NAMED_TARGETS
            or argv[7] == "--native-id" and target in SAFE_STATUS_IDS
        ):
            raise SafetyError("find target is outside the fixture-safe allowlist")
        return
    if command not in {"click", "type", "set-value", "toggle", "check", "uncheck"}:
        raise SafetyError(f"command is forbidden in the safe semantic suite: {command}")
    if not mutation_armed or not window_id:
        raise SafetyError("mutation requires an armed ownership and focus checkpoint")
    if command in {"click", "toggle", "check", "uncheck"}:
        _validate_ref_action_tail(argv, 2)
        return
    if command in {"type", "set-value"}:
        _validate_ref_action_tail(argv, 3)
        value = argv[2]
        if not re.fullmatch(r"safe-semantic-[A-Za-z0-9-]{1,48}", value):
            raise SafetyError("set-value payload is outside the fixture-safe namespace")
        return


def unique_target(data, expected_role, expected_name):
    if not isinstance(data, dict) or not isinstance(data.get("matches"), list):
        raise SafetyError("find data must contain a matches array")
    if len(data["matches"]) != 1:
        raise SafetyError("safe target lookup must resolve exactly one element")
    match = data["matches"][0]
    if match.get("role") != expected_role or match.get("name") != expected_name:
        raise SafetyError("safe target identity does not match the requested fixture control")
    if match.get("interactive") is not True:
        raise SafetyError("safe mutation target is not interactive")
    ref_id = _required_text(match, "ref_id")
    snapshot_id = _required_text(data, "snapshot_id")
    if not REF_PATTERN.fullmatch(ref_id) or not SNAPSHOT_PATTERN.fullmatch(snapshot_id):
        raise SafetyError("safe target has an invalid ref namespace")
    return ref_id, snapshot_id


def unique_value(data, expected_native_id):
    if ("statictext", expected_native_id) not in SAFE_STATUS_IDS:
        raise SafetyError("status identifier is outside the fixture-safe allowlist")
    if not isinstance(data, dict) or not isinstance(data.get("matches"), list):
        raise SafetyError("find data must contain a matches array")
    if len(data["matches"]) != 1:
        raise SafetyError("safe status lookup must resolve exactly one element")
    match = data["matches"][0]
    if match.get("role") != "statictext" or match.get("interactive") is not False:
        raise SafetyError("safe status result is not a noninteractive fixture readout")
    value = match.get("value")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SafetyError("fixture status has no string accessibility value")
    return value


def validate_semantic_action(data, expected_action, expectation):
    if not isinstance(data, dict):
        raise SafetyError("action data must be an object")
    action = _required_text(data, "action").replace("_", "-").casefold()
    if action != expected_action.replace("_", "-").casefold():
        raise SafetyError("action result does not match the requested command")
    disposition = data.get("disposition")
    if not isinstance(disposition, dict):
        raise SafetyError("action result has no delivery disposition")
    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise SafetyError("action result has no auditable steps")
    for step in steps:
        if not isinstance(step, dict):
            raise SafetyError("action result contains a malformed step")
        mechanism = step.get("mechanism")
        if mechanism not in (None, "semantic_api"):
            raise SafetyError("action used a non-semantic mechanism")
    delivery = disposition.get("delivery")
    semantic_success = any(
        step.get("outcome") == "succeeded" and step.get("mechanism") == "semantic_api"
        for step in steps
    )
    if expectation == "changed":
        if delivery not in {"delivered_unverified", "delivered_verified"} or not semantic_success:
            raise SafetyError("state-changing action lacks semantic delivery evidence")
    elif expectation == "noop":
        if delivery != "not_delivered" or semantic_success:
            raise SafetyError("idempotent action unexpectedly reported delivery")
    else:
        raise SafetyError("unknown action expectation")


def render_json(value):
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


def main():
    if len(sys.argv) < 2:
        raise SafetyError("missing guard command")
    command = sys.argv[1]
    if command == "command":
        if len(sys.argv) < 7 or sys.argv[5] != "--":
            raise SafetyError("invalid command guard invocation")
        validate_command(sys.argv[6:], sys.argv[2], sys.argv[3], sys.argv[4] == "1")
    elif command == "frontmost":
        render_json(frontmost_identity(load_envelope_stream(sys.stdin)))
    elif command == "non-fixture-frontmost":
        render_json(
            non_fixture_frontmost_identity(load_envelope_stream(sys.stdin), int(sys.argv[2]))
        )
    elif command == "fixture-window":
        windows = load_envelope_file(sys.argv[4])
        render_json(fixture_window_identity(windows, sys.argv[2], int(sys.argv[3])))
    elif command == "target":
        ref_id, snapshot_id = unique_target(
            load_envelope_stream(sys.stdin), sys.argv[2], sys.argv[3]
        )
        print(f"{ref_id}\t{snapshot_id}")
    elif command == "value":
        print(unique_value(load_envelope_stream(sys.stdin), sys.argv[2]))
    elif command == "semantic-action":
        validate_semantic_action(load_envelope_stream(sys.stdin), sys.argv[2], sys.argv[3])
    else:
        raise SafetyError(f"unknown guard command: {command}")


if __name__ == "__main__":
    try:
        main()
    except (SafetyError, IndexError, OSError, ValueError) as error:
        print(f"safe semantic guard rejected input: {error}", file=sys.stderr)
        raise SystemExit(2) from error
