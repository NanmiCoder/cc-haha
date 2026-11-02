use super::*;
use crate::cli_args::Surface;
use crate::test_noop_ops::NoopAdapter;
use agent_desktop_core::{PermissionReport, response::output::ENVELOPE_VERSION};
use clap::CommandFactory;

fn item(command: &str, args: Value) -> BatchCommand {
    BatchCommand {
        command: command.to_string(),
        session: None,
        args,
    }
}

#[test]
fn parses_optional_batch_session_scope() {
    let commands = agent_desktop_core::commands::batch::parse_commands(
        r#"[{"command":"status","session":"agent-a","args":{}}]"#,
    )
    .unwrap();

    assert_eq!(commands[0].session.as_deref(), Some("agent-a"));
}

#[test]
fn rejects_per_item_cursor_configuration() {
    let error = agent_desktop_core::commands::batch::parse_commands(
        r#"[{"command":"status","agent_cursor":{"enabled":true},"args":{}}]"#,
    )
    .expect_err("cursor configuration belongs to the session command");

    assert!(error.to_string().contains("agent_cursor"));
}

#[test]
fn session_batch_rejects_unknown_field() {
    assert!(
        parse_command(item("session", serde_json::json!({ "action": "start" }))).is_ok(),
        "a valid session start must still parse"
    );
    let err = parse_command(item(
        "session",
        serde_json::json!({ "action": "start", "no_trce": true }),
    ))
    .expect_err("a misspelled session field must be rejected, not silently defaulted");
    assert!(err.to_string().contains("no_trce"));
}

#[test]
fn parses_ref_command_into_cli_enum() {
    let command = parse_command(item(
        "click",
        serde_json::json!({ "ref_id": "@s8f3k2p9:e1" }),
    ))
    .expect("click parses");

    match command {
        Commands::Click(args) => {
            assert_eq!(args.ref_id, "@s8f3k2p9:e1");
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn rejects_the_removed_snapshot_field_on_ref_commands() {
    for key in ["snapshot", "snapshot_id"] {
        let err = parse_command(item(
            "click",
            serde_json::json!({ "ref_id": "@s8f3k2p9:e1", key: "s8f3k2p9" }),
        ))
        .expect_err("a snapshot field no longer qualifies anything");
        assert!(err.to_string().contains(key), "{key}: {err}");
    }
}

#[test]
fn applies_cli_defaults_during_batch_decode() {
    let command = parse_command(item("snapshot", serde_json::json!({}))).expect("snapshot parses");

    match command {
        Commands::Snapshot(args) => {
            assert_eq!(args.tree.max_depth, 10);
            assert!(!args.tree.interactive_only);
            assert!(matches!(args.surface, Surface::Window));
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn rejects_unknown_batch_args() {
    let err = parse_command(item(
        "click",
        serde_json::json!({ "ref_id": "@e1", "x": 1 }),
    ))
    .expect_err("unknown field is rejected");

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn rejects_unknown_wait_batch_args_after_flattening() {
    let err = parse_command(item(
        "wait",
        serde_json::json!({ "ms": 1, "unexpected": true }),
    ))
    .expect_err("unknown wait field is rejected");

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn rejects_version_args_after_json_flag_removal() {
    let err = parse_command(item("version", serde_json::json!({ "json": true })))
        .expect_err("version no longer accepts args");

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn stop_on_error_halts_after_first_failure() {
    let args = BatchArgs {
        commands_json: serde_json::json!([
            {"command": "snapshot", "args": {}},
            {"command": "version", "args": {}}
        ])
        .to_string(),
        stop_on_error: true,
        timeout_ms: 60_000,
    };

    let value = execute(
        args,
        &NoopAdapter,
        &PermissionReport::default(),
        &agent_desktop_core::CommandContext::default(),
    )
    .unwrap();
    let results = value["results"].as_array().unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["ok"], false);
    assert_eq!(results[0]["version"], ENVELOPE_VERSION);
    assert_eq!(results[0]["command"], "snapshot");
    assert_eq!(results[0]["error"]["code"], "PLATFORM_NOT_SUPPORTED");
}

#[test]
fn no_args_rejection_has_suggestion() {
    let err = parse_command(item("status", serde_json::json!({"x": 1})))
        .expect_err("status rejects args");

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.suggestion().is_some());
}

#[test]
fn list_displays_accepts_only_empty_args() {
    assert!(matches!(
        parse_command(item("list-displays", serde_json::Value::Null)),
        Ok(Commands::ListDisplays)
    ));
    assert!(matches!(
        parse_command(item("list-displays", serde_json::json!({}))),
        Ok(Commands::ListDisplays)
    ));

    let err = parse_command(item("list-displays", serde_json::json!({ "display": 1 })))
        .expect_err("list-displays rejects unknown args");
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn nested_batch_rejection_has_suggestion() {
    let err = parse_command(item("batch", serde_json::json!({}))).expect_err("batch rejected");

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.suggestion().is_some());
}

#[test]
fn trace_batch_show_parses() {
    let command = parse_command(item(
        "trace",
        serde_json::json!({ "action": "show", "limit": 0, "event": "action." }),
    ))
    .expect("trace show parses");

    match command {
        Commands::Trace(args) => match args.action {
            crate::cli_args::trace::TraceAction::Show(show) => {
                assert_eq!(show.limit, 0);
                assert_eq!(show.event.as_deref(), Some("action."));
            }
            other => panic!("unexpected trace action: {other:?}"),
        },
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn trace_batch_export_parses() {
    let command = parse_command(item(
        "trace",
        serde_json::json!({ "action": "export", "limit": 100 }),
    ))
    .expect("trace export parses");

    match command {
        Commands::Trace(args) => match args.action {
            crate::cli_args::trace::TraceAction::Export(export) => {
                assert_eq!(export.limit, 100);
                assert!(export.out.is_none());
            }
            other => panic!("unexpected trace action: {other:?}"),
        },
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn trace_batch_rejects_unknown_field() {
    let err = parse_command(item(
        "trace",
        serde_json::json!({ "action": "show", "limitt": 1 }),
    ))
    .expect_err("unknown trace field rejected");
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn batch_variants_reject_known_but_inapplicable_fields() {
    for (command, args) in [
        ("skills", serde_json::json!({"action": "list", "name": "x"})),
        (
            "skills",
            serde_json::json!({"action": "path", "full": false}),
        ),
        ("trace", serde_json::json!({"action": "show", "out": "x"})),
        (
            "trace",
            serde_json::json!({"action": "export", "event": "x"}),
        ),
    ] {
        let error = parse_command(item(command, args))
            .expect_err("fields for another action must be rejected");
        assert_eq!(error.code(), "INVALID_ARGS");
    }
}

#[test]
fn session_batch_accepts_screenshots_flag() {
    let command = parse_command(item(
        "session",
        serde_json::json!({ "action": "start", "screenshots": true }),
    ))
    .expect("session start with screenshots parses");

    match command {
        Commands::Session(args) => match args.action {
            crate::cli_args::session::SessionAction::Start(start) => {
                assert!(start.screenshots);
            }
            other => panic!("unexpected action: {other:?}"),
        },
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn session_batch_end_rejects_start_only_field() {
    let err = parse_command(item(
        "session",
        serde_json::json!({ "action": "end", "screenshots": true }),
    ))
    .expect_err("'screenshots' is not valid for the 'end' action and must be rejected");

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.to_string().contains("screenshots"));
}

#[test]
fn session_batch_gc_parses_older_than() {
    let command = parse_command(item(
        "session",
        serde_json::json!({ "action": "gc", "older_than": 5, "ended": true }),
    ))
    .expect("session gc parses");

    match command {
        Commands::Session(args) => match args.action {
            crate::cli_args::session::SessionAction::Gc(gc) => {
                assert_eq!(gc.older_than, Some(5));
                assert!(gc.ended);
            }
            other => panic!("unexpected action: {other:?}"),
        },
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn session_batch_end_parses_id() {
    let command = parse_command(item(
        "session",
        serde_json::json!({ "action": "end", "id": "s-1" }),
    ))
    .expect("session end parses");

    match command {
        Commands::Session(args) => match args.action {
            crate::cli_args::session::SessionAction::End(end) => {
                assert_eq!(end.id.as_deref(), Some("s-1"));
            }
            other => panic!("unexpected action: {other:?}"),
        },
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn every_cli_subcommand_is_known_to_batch_parser() {
    for subcommand in crate::cli::Cli::command().get_subcommands() {
        let name = subcommand.get_name();
        let result = parse_command(item(name, serde_json::json!({})));
        if name == "batch" {
            assert!(result.unwrap_err().to_string().contains("nested"));
            continue;
        }
        if let Err(err) = result {
            assert!(
                !err.to_string().contains("Unknown batch command"),
                "{name} is missing from batch parser"
            );
        }
    }
}
