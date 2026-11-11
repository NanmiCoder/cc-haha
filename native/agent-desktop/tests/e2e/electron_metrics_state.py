from electron_metrics_common import MeasurementError, parse_envelope
from json_tool import run_bounded


def target_window_id(windows):
    visible = [
        window
        for window in windows
        if window.get("visible") is True and window.get("minimized") is not True
    ]
    if len(visible) == 1:
        return visible[0]["id"]
    focused = [window for window in visible if window.get("is_focused") is True]
    if len(focused) == 1:
        return focused[0]["id"]
    raise MeasurementError("state probe requires one unambiguous visible target window")


def capture_app_state(runner, args):
    def invoke(*arguments):
        result = run_bounded(
            [runner.binary, *arguments],
            timeout_seconds=args.timeout_seconds,
            max_capture_bytes=args.capture_limit_bytes,
            env=runner.environment,
            inherit_interaction_lease=True,
        )
        return parse_envelope(result, f"state probe {' '.join(arguments)}")["data"]

    apps = invoke("list-apps", "--app", args.app).get("apps", [])
    exact = [item for item in apps if item.get("name", "").casefold() == args.app.casefold()]
    if len(exact) != 1 or not exact[0].get("process_instance"):
        raise MeasurementError("state probe requires one exact app with a process generation")
    process = exact[0]
    windows = [
        window
        for window in invoke("list-windows", "--app", args.app)
        if window.get("pid") == process.get("pid")
    ]
    if not windows or any(
        not window.get("id")
        or window.get("process_instance") != process.get("process_instance")
        for window in windows
    ):
        raise MeasurementError("state probe requires exact-generation windows")
    state_fields = (
        "id",
        "title",
        "pid",
        "process_instance",
        "bounds",
        "is_focused",
        "minimized",
        "visible",
    )
    normalized_windows = sorted(
        ({key: window.get(key) for key in state_fields} for window in windows),
        key=lambda window: window["id"],
    )
    return {
        "app": {
            key: process.get(key)
            for key in ("name", "pid", "bundle_id", "process_instance")
        },
        "target_window_id": target_window_id(normalized_windows),
        "windows": normalized_windows,
    }


def assert_stable(reference, observed, phase):
    if observed != reference:
        raise MeasurementError(f"app process generation or window state changed {phase}")
