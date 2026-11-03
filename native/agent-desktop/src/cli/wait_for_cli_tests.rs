use super::{Cli, Commands};
use agent_desktop_core::context::WaitSelector;
use clap::{CommandFactory, Parser};

fn selector(query_raw: &str) -> WaitSelector {
    WaitSelector {
        query_raw: query_raw.into(),
        gone: false,
        timeout_ms: 30_000,
    }
}

fn command(arguments: &[&str]) -> Commands {
    let mut argv = vec!["agent-desktop"];
    argv.extend_from_slice(arguments);
    Cli::try_parse_from(argv)
        .expect("command parses")
        .command
        .expect("subcommand is present")
}

#[test]
fn help_lists_global_wait_for_flags() {
    let help = Cli::command().render_help();
    let help = help.to_string();
    assert!(help.contains("--wait-for"));
    assert!(help.contains("--wait-for-gone"));
    assert!(help.contains("--wait-timeout"));
}

#[test]
fn wait_for_and_wait_for_gone_conflict() {
    let err = Cli::try_parse_from([
        "agent-desktop",
        "--wait-for",
        "button:OK",
        "--wait-for-gone",
        "button:Spinner",
        "snapshot",
        "--app",
        "Finder",
    ])
    .expect_err("mutually exclusive wait flags must fail parse");
    assert_eq!(err.exit_code(), 2);
}

#[test]
fn short_w_flag_maps_to_wait_for() {
    let cli = Cli::try_parse_from([
        "agent-desktop",
        "-w",
        "button:Submit",
        "snapshot",
        "--app",
        "Finder",
    ])
    .expect("short -w should parse");
    assert_eq!(
        cli.post_action_wait.wait_for.as_deref(),
        Some("button:Submit")
    );
    assert_eq!(cli.post_action_wait.wait_timeout, None);
    assert_eq!(
        crate::build_wait_selector(&cli)
            .expect("selector is valid")
            .expect("selector is present")
            .timeout_ms,
        30_000
    );
}

#[test]
fn wait_timeout_parses_custom_value() {
    let cli = Cli::try_parse_from([
        "agent-desktop",
        "--wait-for",
        "button:OK",
        "--wait-timeout",
        "5000",
        "snapshot",
    ])
    .expect("custom wait timeout should parse");
    assert_eq!(cli.post_action_wait.wait_timeout, Some(5_000));
}

#[test]
fn wait_timeout_without_selector_is_rejected_before_dispatch() {
    let cli = Cli::try_parse_from(["agent-desktop", "--wait-timeout", "5000", "snapshot"])
        .expect("syntax parses before semantic validation");

    let error = crate::build_wait_selector(&cli)
        .expect_err("an unused wait timeout must not be silently ignored");
    assert_eq!(error.code(), "INVALID_ARGS");
}

#[test]
fn validate_rejects_unsupported_command() {
    let err = crate::validate_wait_for_command(
        &command(&["find", "--role", "button"]),
        &selector("button:OK"),
    )
    .expect_err("find must not accept --wait-for");
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn validate_rejects_match_everything_selector_before_dispatch() {
    let click = command(&["click", "@e1"]);
    let err = crate::validate_wait_for_command(&click, &selector(""))
        .expect_err("empty selector must be rejected before the action runs");
    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(crate::validate_wait_for_command(&click, &selector(":")).is_err());
}

#[test]
fn validate_accepts_supported_command_with_constraining_selector() {
    for supported in [
        command(&["snapshot"]),
        command(&["press", "cmd+k", "--app", "GarageBand"]),
        command(&["click", "@e1"]),
        command(&["hover", "@e1"]),
        command(&["drag", "--from", "@e1", "--to", "@e2"]),
    ] {
        assert!(crate::validate_wait_for_command(&supported, &selector(":Saved!")).is_ok());
    }
}

#[test]
fn typed_metadata_names_each_variant() {
    let hover = command(&["hover", "@e1"]);
    let drag = command(&["drag", "--from", "@e1", "--to", "@e2"]);
    let find = command(&["find", "--role", "button"]);

    assert_eq!(hover.name(), "hover");
    assert_eq!(drag.name(), "drag");
    assert_eq!(find.name(), "find");
}

#[cfg(target_os = "macos")]
#[test]
fn caller_coordinates_batches_sessions_and_permission_guidance() {
    assert!(command(&["permissions", "--guide"]).needs_caller_process());
    assert!(command(&["session", "end", "other"]).needs_caller_process());
    assert!(command(&["session", "gc"]).needs_caller_process());
    assert!(command(&["batch", "[]"]).needs_caller_process());
    assert!(!command(&["permissions"]).needs_caller_process());
    assert!(!command(&["permissions", "--request"]).needs_caller_process());
    assert!(!command(&["click", "@e1"]).needs_caller_process());
}

#[test]
fn mutation_metadata_distinguishes_read_only_and_file_writing_forms() {
    assert!(command(&["click", "@e1"]).is_mutating());
    assert!(!command(&["find", "--role", "button"]).is_mutating());
    assert!(!command(&["screenshot"]).is_mutating());
    assert!(command(&["screenshot", "/tmp/capture.png"]).is_mutating());
    assert!(!command(&["clipboard-get"]).is_mutating());
    assert!(command(&["clipboard-get", "--out", "/tmp/clipboard.png"]).is_mutating());
    assert!(!command(&["permissions"]).is_mutating());
    assert!(command(&["permissions", "--request"]).is_mutating());
    assert!(!command(&["session", "list"]).is_mutating());
    assert!(command(&["session", "start"]).is_mutating());
    assert!(!command(&["trace", "show"]).is_mutating());
    assert!(command(&["trace", "export"]).is_mutating());
}

fn drag_args(arguments: &[&str]) -> crate::cli_args::drag::DragCliArgs {
    let command = command(arguments);
    let crate::cli::Commands::Drag(args) = command else {
        panic!("expected a drag command, got {:?}", command.name());
    };
    args
}

#[test]
fn wait_for_scope_defaults_absent_and_dispatch_applies_the_destination_default() {
    let args = drag_args(&["drag", "--from", "@e1", "--to", "@e2"]);
    assert_eq!(
        args.wait_for_scope, None,
        "the flag is optional; the destination default is applied in the dispatch layer",
    );
}

#[test]
fn wait_for_scope_to_and_from_parse_to_the_named_scope() {
    assert_eq!(
        drag_args(&[
            "drag",
            "--from",
            "@e1",
            "--to",
            "@e2",
            "--wait-for-scope",
            "to"
        ])
        .wait_for_scope,
        Some(crate::cli_args::drag::WaitForScopeArg::To),
    );
    assert_eq!(
        drag_args(&[
            "drag",
            "--from",
            "@e1",
            "--to",
            "@e2",
            "--wait-for-scope",
            "from"
        ])
        .wait_for_scope,
        Some(crate::cli_args::drag::WaitForScopeArg::From),
    );
}

#[test]
fn wait_for_scope_rejects_unknown_values() {
    let err = Cli::try_parse_from([
        "agent-desktop",
        "drag",
        "--from",
        "@e1",
        "--to",
        "@e2",
        "--wait-for-scope",
        "destination",
    ])
    .expect_err("an unknown scope value must fail parse");
    assert_eq!(err.exit_code(), 2);
}
