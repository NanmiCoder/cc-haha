use super::Cli;
use clap::Parser;

#[test]
fn identity_is_global_including_cursor_configuration() {
    for args in [
        vec![
            "agent-desktop",
            "--session",
            "run",
            "--agent-id",
            "a",
            "cursor-overlay",
            "enable",
        ],
        vec![
            "agent-desktop",
            "cursor-overlay",
            "enable",
            "--session",
            "run",
            "--agent-id",
            "a",
        ],
    ] {
        let cli = Cli::try_parse_from(args).unwrap();
        assert_eq!(cli.identity.session.as_deref(), Some("run"));
        assert_eq!(cli.identity.agent_id.as_deref(), Some("a"));
    }
    assert!(Cli::try_parse_from(["agent-desktop", "session", "start", "--multi-agent"]).is_err());
    assert!(
        Cli::try_parse_from([
            "agent-desktop",
            "session",
            "start",
            "--cursor",
            "--multi-agent"
        ])
        .is_ok()
    );
}
