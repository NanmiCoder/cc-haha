use agent_desktop_core::{AdapterError, AppError, DeliveryDisposition, RetryDisposition};
use clap::Parser;

#[test]
fn visual_debug_flags_accept_snapshot_and_click() {
    for args in [
        vec![
            "agent-desktop",
            "snapshot",
            "--app",
            "TextEdit",
            "--skeleton",
            "-i",
            "--debug",
            "--screenshot",
            "/tmp/skeleton.html",
        ],
        vec![
            "agent-desktop",
            "click",
            "@sdemo:e1",
            "--debug",
            "--screenshot",
            "/tmp/click.html",
        ],
    ] {
        assert!(crate::Cli::try_parse_from(args).is_ok());
    }
}

#[test]
fn visual_debug_flags_require_explicit_capture_consent_and_path() {
    for flags in [vec!["--debug"], vec!["--screenshot", "/tmp/debug.html"]] {
        let mut args = vec!["agent-desktop", "snapshot"];
        args.extend(flags);
        assert!(crate::Cli::try_parse_from(args).is_err());
    }
}

#[path = "batch_seen_set_tests.rs"]
mod batch_seen_set_tests;

#[test]
fn pre_dispatch_failures_are_always_safe_to_retry() {
    for error in [
        AppError::from(AdapterError::internal("trace setup failed")),
        AppError::from(std::io::Error::other("read failed")),
    ] {
        let AppError::Adapter(error) = crate::pre_dispatch_error(error) else {
            panic!("pre-dispatch error must be normalized to AdapterError");
        };
        assert_eq!(error.disposition.retry(), RetryDisposition::Safe);
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
    }
}
