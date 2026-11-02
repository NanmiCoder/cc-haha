use super::*;

/// Chromium switches all start with `--`, and `--arg` passthrough exists
/// specifically to forward them; clap rejects a hyphen-leading value on a
/// plain option unless `allow_hyphen_values` says otherwise.
#[test]
fn launch_arg_passthrough_accepts_a_hyphen_leading_value() {
    let args = LaunchArgs::try_parse_from(["launch", "X", "--arg", "--remote-debugging-port=9229"])
        .unwrap();

    assert_eq!(args.args, vec!["--remote-debugging-port=9229"]);
}

/// `num_args(0..=1)` with `default_missing_value` makes `--cdp` alone mean
/// "auto-pick a port" (represented as the sentinel `Some(0)`) so callers
/// are not forced to invent a port number just to ask for the endpoint.
#[test]
fn launch_cdp_flag_defaults_to_auto_pick_when_bare() {
    let args = LaunchArgs::try_parse_from(["launch", "X", "--cdp"]).unwrap();

    assert_eq!(args.cdp, Some(0));
}

#[test]
fn launch_cdp_flag_accepts_an_explicit_port() {
    let args = LaunchArgs::try_parse_from(["launch", "X", "--cdp", "9229"]).unwrap();

    assert_eq!(args.cdp, Some(9229));
}

#[test]
fn launch_cdp_flag_is_absent_when_not_given() {
    let args = LaunchArgs::try_parse_from(["launch", "X"]).unwrap();

    assert_eq!(args.cdp, None);
}

#[test]
fn launch_cdp_batch_json_parses_an_explicit_zero_and_an_absent_field() {
    let auto: LaunchArgs = serde_json::from_value(serde_json::json!({
        "app": "X",
        "cdp": 0
    }))
    .unwrap();
    let absent: LaunchArgs = serde_json::from_value(serde_json::json!({ "app": "X" })).unwrap();

    assert_eq!(auto.cdp, Some(0));
    assert_eq!(absent.cdp, None);
}

/// God-object regression: `WaitModeArgs` used to carry 9 flat fields;
/// `event`/`window_id` now live in `WaitEventArgs`, flattened onto
/// `WaitArgs` as a sibling of `mode`/`predicate` (nesting it inside
/// `WaitModeArgs` instead hits a real serde limitation — see the doc
/// comment on `WaitArgs`). Proves the CLI surface is unchanged by the
/// regrouping — a missing `#[command(flatten)]` would make clap reject
/// `--event`/`--window-id` as unrecognized.
#[test]
fn wait_event_and_window_id_still_resolve_through_the_flattened_group() {
    let args =
        WaitArgs::try_parse_from(["wait", "--event", "window-opened", "--window-id", "w-42"])
            .unwrap();

    assert_eq!(args.event.event.as_deref(), Some("window-opened"));
    assert_eq!(args.event.window_id.as_deref(), Some("w-42"));
}

/// Batch JSON is decoded straight into `WaitArgs` via serde; a flat payload
/// (the shape every existing caller sends) must still deserialize now that
/// `event`/`window_id` live on the separate `WaitEventArgs` group.
#[test]
fn wait_args_batch_json_flat_event_payload_deserializes_into_flattened_group() {
    let args: WaitArgs = serde_json::from_value(serde_json::json!({
        "event": "app-launched",
        "window_id": "w-7"
    }))
    .unwrap();

    assert_eq!(args.event.event.as_deref(), Some("app-launched"));
    assert_eq!(args.event.window_id.as_deref(), Some("w-7"));
    assert!(args.mode.element.is_none());
    assert_eq!(args.timeout, 30000);
}

/// The three-way sibling flatten (`mode`/`event`/`predicate`) must still
/// reject a genuinely unrecognized batch-JSON key — the exact property
/// `rejects_unknown_wait_batch_args_after_flattening` in `batch::tests`
/// already guards for the two-flatten-field shape; this extends it to the
/// three-field shape introduced by this split.
#[test]
fn wait_args_batch_json_rejects_unknown_field_across_three_flattened_groups() {
    let err = serde_json::from_value::<WaitArgs>(serde_json::json!({
        "ms": 1,
        "totally_bogus": true
    }))
    .unwrap_err();

    assert!(err.to_string().contains("totally_bogus"));
}

#[test]
fn window_mutation_args_accept_window_ids() {
    let resize = ResizeWindowCliArgs::try_parse_from([
        "resize-window",
        "--window-id",
        "w-42",
        "--width",
        "800",
        "--height",
        "600",
    ])
    .unwrap();
    let move_window = MoveWindowCliArgs::try_parse_from([
        "move-window",
        "--window-id",
        "w-42",
        "--x",
        "10",
        "--y",
        "20",
    ])
    .unwrap();
    let minimize = AppRefArgs::try_parse_from(["minimize", "--window-id", "w-42"]).unwrap();

    assert_eq!(resize.scope.window_id.as_deref(), Some("w-42"));
    assert_eq!(move_window.scope.window_id.as_deref(), Some("w-42"));
    assert_eq!(minimize.scope.window_id.as_deref(), Some("w-42"));
}
