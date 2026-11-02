use super::{Cli, Commands};
use crate::cli_args::cursor_overlay_action::CursorOverlayAction;
use clap::Parser;
use std::path::Path;

#[test]
fn product_bridge_cursor_arguments_parse_with_the_product_style() {
    let cli = Cli::try_parse_from([
        "agent-desktop",
        "--session",
        "host-session",
        "cursor-overlay",
        "enable",
        "--multi-agent",
        "--fill",
        "#0075F2",
        "--rim",
        "#FFFFFF",
        "--accent",
        "#4D9EFF",
        "--size",
        "1",
    ])
    .unwrap();
    assert_eq!(cli.identity.session.as_deref(), Some("host-session"));
    assert!(cli.identity.agent_id.is_none());
    let Some(Commands::CursorOverlay(args)) = cli.command else {
        panic!("cursor command")
    };
    let CursorOverlayAction::Enable(args) = args.action else {
        panic!("enable action")
    };
    assert!(args.multi_agent);
    let style = args.to_core().unwrap().style().clone();
    assert_eq!(style.fill_rgb(), [0.0, 117.0 / 255.0, 242.0 / 255.0]);
    assert_eq!(style.rim_rgb(), [1.0, 1.0, 1.0]);
    assert_eq!(style.size(), 1.0);
}

#[test]
fn product_bridge_owned_image_arguments_parse_as_output_paths() {
    let cli = Cli::try_parse_from([
        "agent-desktop",
        "--session",
        "host-session",
        "--agent-id",
        "writer",
        "--headed",
        "screenshot",
        "--app",
        "Fixture",
        "/tmp/owned.png",
    ])
    .unwrap();
    assert_eq!(cli.identity.agent_id.as_deref(), Some("writer"));
    let Some(Commands::Screenshot(args)) = cli.command else {
        panic!("screenshot command")
    };
    assert_eq!(args.scope.app.as_deref(), Some("Fixture"));
    assert_eq!(
        args.output_path.as_deref(),
        Some(Path::new("/tmp/owned.png"))
    );

    let cli = Cli::try_parse_from([
        "agent-desktop",
        "clipboard-get",
        "--format",
        "image",
        "--out",
        "/tmp/owned.png",
    ])
    .unwrap();
    let Some(Commands::ClipboardGet(args)) = cli.command else {
        panic!("clipboard command")
    };
    assert_eq!(args.format.as_deref(), Some("image"));
    assert_eq!(args.out.as_deref(), Some(Path::new("/tmp/owned.png")));
}

#[test]
fn product_bridge_batch_uses_native_session_and_screenshot_fields() {
    let entries = agent_desktop_core::commands::batch::parse_commands(r#"[
        {"command":"screenshot","session":"host-session","args":{"app":"Fixture","output_path":"/tmp/owned.png"}},
        {"command":"session","session":"host-session","args":{"action":"end","id":"host-session"}}
    ]"#).unwrap();
    let mut entries = entries.into_iter();
    let screenshot = entries.next().unwrap();
    assert_eq!(screenshot.session.as_deref(), Some("host-session"));
    let Commands::Screenshot(args) = crate::batch::parse_command(screenshot).unwrap() else {
        panic!("screenshot batch item")
    };
    assert_eq!(
        args.output_path.as_deref(),
        Some(Path::new("/tmp/owned.png"))
    );
    let Commands::Session(args) = crate::batch::parse_command(entries.next().unwrap()).unwrap()
    else {
        panic!("session batch item")
    };
    let crate::cli_args::session::SessionAction::End(args) = args.action else {
        panic!("end session")
    };
    assert_eq!(args.id.as_deref(), Some("host-session"));
}

#[test]
fn known_global_flags_between_ref_and_text_remain_options() {
    for command in ["type", "set-value"] {
        let cli = Cli::try_parse_from([
            "agent-desktop",
            command,
            "@s:e1",
            "--headed",
            "--trace=/tmp/foreign.jsonl",
            "hello",
        ])
        .unwrap();
        assert!(cli.interaction.headed);
        assert_eq!(cli.trace.as_deref(), Some(Path::new("/tmp/foreign.jsonl")));
    }
    let help = Cli::try_parse_from(["agent-desktop", "type", "@s:e1", "--help"]).unwrap_err();
    assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
    let cli = Cli::try_parse_from([
        "agent-desktop",
        "set-value",
        "@s:e1",
        "--interval-ms",
        "--headed",
        "--trace=/tmp/foreign.jsonl",
    ])
    .unwrap();
    assert!(cli.interaction.headed);
    assert_eq!(cli.trace.as_deref(), Some(Path::new("/tmp/foreign.jsonl")));
    let Some(Commands::SetValue(args)) = cli.command else {
        panic!("set-value command")
    };
    assert_eq!(args.value, "--interval-ms");
}

#[test]
fn literal_text_and_launch_arguments_do_not_change_global_input_policy() {
    for value in [
        "--headed",
        "--trace=/tmp/foreign.jsonl",
        "--help",
        "--debug",
    ] {
        let cli = Cli::try_parse_from(["agent-desktop", "type", "@s:e1", "--", value]).unwrap();
        assert!(!cli.interaction.headed);
        assert!(cli.trace.is_none());
        let Some(Commands::Type(args)) = cli.command else {
            panic!("type command")
        };
        assert_eq!(args.text, value);
        let cli =
            Cli::try_parse_from(["agent-desktop", "launch", "Fixture", "--arg", value]).unwrap();
        assert!(!cli.interaction.headed);
        assert!(cli.trace.is_none());
        let Some(Commands::Launch(args)) = cli.command else {
            panic!("launch command")
        };
        assert_eq!(args.args, vec![value]);
    }
}
