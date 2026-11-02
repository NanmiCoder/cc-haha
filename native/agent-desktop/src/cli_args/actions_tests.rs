use super::*;
use crate::cli_args::drag::DragCliArgs;
use clap::CommandFactory;

/// F2 regression: `TypeArgs`, `SetValueArgs`, `SelectArgs`, `ScrollArgs`,
/// `HoverArgs`, and `DragCliArgs` previously had no `--timeout-ms` field at
/// all, so the auto-wait budget these commands' CLI docs promise was
/// unreachable for them. Each pair below proves the paired clap/serde default
/// (5000) actually fires from both entry points: clap's `default_value_t`
/// covers the CLI, and `#[serde(default = "default_ref_timeout_ms")]` covers
/// batch JSON, since clap defaults never fire during `serde_json::from_value`.
#[test]
fn type_args_cli_omitted_timeout_scales_with_the_text() {
    let args = TypeArgs::try_parse_from(["type", "@e1", "hello"]).unwrap();
    assert_eq!(args.timeout_ms, None);
    assert_eq!(args.effective_timeout_ms(), 5150);
}

#[test]
fn type_args_cli_explicit_timeout_is_honored() {
    let args = TypeArgs::try_parse_from(["type", "@e1", "hello", "--timeout-ms", "1500"]).unwrap();
    assert_eq!(args.effective_timeout_ms(), 1500);
}

#[test]
fn type_args_batch_json_omitted_timeout_scales_with_the_text() {
    let args: TypeArgs =
        serde_json::from_value(serde_json::json!({ "ref_id": "@e1", "text": "hello" })).unwrap();
    assert_eq!(args.effective_timeout_ms(), 5150);
}

#[test]
fn set_value_args_cli_omitted_timeout_defaults_to_5000() {
    let args = SetValueArgs::try_parse_from(["set-value", "@e1", "value"]).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn set_value_args_batch_json_omitted_timeout_defaults_to_5000() {
    let args: SetValueArgs =
        serde_json::from_value(serde_json::json!({ "ref_id": "@e1", "value": "v" })).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn select_args_cli_omitted_timeout_defaults_to_5000() {
    let args = SelectArgs::try_parse_from(["select", "@e1", "choice"]).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn select_args_batch_json_omitted_timeout_defaults_to_5000() {
    let args: SelectArgs =
        serde_json::from_value(serde_json::json!({ "ref_id": "@e1", "value": "choice" })).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn scroll_args_cli_omitted_timeout_defaults_to_5000() {
    let args = ScrollArgs::try_parse_from(["scroll", "@e1"]).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn scroll_args_batch_json_omitted_timeout_defaults_to_5000() {
    let args: ScrollArgs = serde_json::from_value(serde_json::json!({ "ref_id": "@e1" })).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn hover_args_cli_omitted_timeout_defaults_to_5000() {
    let args = HoverArgs::try_parse_from(["hover", "@e1"]).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn hover_args_batch_json_omitted_timeout_defaults_to_5000() {
    let args: HoverArgs = serde_json::from_value(serde_json::json!({ "ref_id": "@e1" })).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

#[test]
fn hover_help_discloses_stateless_duration_rejection() {
    let help = HoverArgs::command().render_long_help().to_string();
    assert!(help.contains("positive values are rejected in stateless mode"));
    assert!(help.contains("wait <ms>"));
}

#[test]
fn drag_cli_args_cli_omitted_timeout_defaults_to_5000() {
    let args = DragCliArgs::try_parse_from(["drag", "--from", "@e1", "--to", "@e2"]).unwrap();
    assert_eq!(args.timeout_ms, 5000);
    assert_eq!(args.target.from.as_deref(), Some("@e1"));
    assert_eq!(args.target.to.as_deref(), Some("@e2"));
}

#[test]
fn drag_cli_args_batch_json_omitted_timeout_defaults_to_5000() {
    let args: DragCliArgs =
        serde_json::from_value(serde_json::json!({ "from": "@e1", "to": "@e2" })).unwrap();
    assert_eq!(args.timeout_ms, 5000);
}

/// F10 regression: `MouseClickArgs`/`MousePointArgs` (mouse-click, mouse-down,
/// mouse-up) previously had no `--modifiers` flag at all — only mouse-wheel
/// carried one — so a chorded click was unreachable from the CLI regardless
/// of what the macOS layer supported. Each pair proves the repeatable flag
/// parses on the CLI and that legacy batch JSON without the key still
/// deserializes (serde default empty), matching `MouseWheelArgs`'s existing
/// contract.
#[test]
fn mouse_click_args_cli_modifiers_repeatable_flag_parses() {
    let args = MouseClickArgs::try_parse_from([
        "mouse-click",
        "--xy",
        "10,20",
        "--modifiers",
        "cmd",
        "--modifiers",
        "shift",
    ])
    .unwrap();
    assert_eq!(args.modifiers, vec!["cmd".to_string(), "shift".to_string()]);
}

#[test]
fn mouse_click_args_cli_omitted_modifiers_defaults_to_empty() {
    let args = MouseClickArgs::try_parse_from(["mouse-click", "--xy", "10,20"]).unwrap();
    assert!(args.modifiers.is_empty());
}

#[test]
fn mouse_click_args_batch_json_without_modifiers_key_still_deserializes() {
    let args: MouseClickArgs =
        serde_json::from_value(serde_json::json!({ "xy": "10,20" })).unwrap();
    assert!(args.modifiers.is_empty());
}

#[test]
fn mouse_point_args_cli_modifiers_repeatable_flag_parses() {
    let args =
        MousePointArgs::try_parse_from(["mouse-down", "--xy", "10,20", "--modifiers", "ctrl"])
            .unwrap();
    assert_eq!(args.modifiers, vec!["ctrl".to_string()]);
}

#[test]
fn mouse_point_args_cli_omitted_modifiers_defaults_to_empty() {
    let args = MousePointArgs::try_parse_from(["mouse-up", "--xy", "10,20"]).unwrap();
    assert!(args.modifiers.is_empty());
}

#[test]
fn mouse_point_args_batch_json_without_modifiers_key_still_deserializes() {
    let args: MousePointArgs =
        serde_json::from_value(serde_json::json!({ "xy": "10,20" })).unwrap();
    assert!(args.modifiers.is_empty());
}

#[test]
fn type_args_with_an_interval_budget_the_spread_plus_each_keystroke() {
    let paced = TypeArgs::try_parse_from(["type", "@e1", "abc", "--interval-ms", "100"]).unwrap();
    assert_eq!(paced.effective_timeout_ms(), 300 + 5_090);

    let explicit = TypeArgs::try_parse_from([
        "type",
        "@e1",
        "abc",
        "--interval-ms",
        "100",
        "--timeout-ms",
        "500",
    ])
    .unwrap();
    assert_eq!(explicit.effective_timeout_ms(), 300 + 3 * 500);

    let untimed = TypeArgs::try_parse_from([
        "type",
        "@e1",
        "abc",
        "--interval-ms",
        "100",
        "--timeout-ms",
        "0",
    ])
    .unwrap();
    assert_eq!(untimed.effective_timeout_ms(), 300 + 5_090);

    assert!(TypeArgs::try_parse_from(["type", "@e1", "abc", "--interval-ms", "0"]).is_err());
}
