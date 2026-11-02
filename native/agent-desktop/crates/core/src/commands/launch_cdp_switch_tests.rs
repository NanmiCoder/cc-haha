use super::cdp_test_support::{CdpAdapter, adapter_error, empty_cdp_adapter};
use super::*;
use crate::system::launch_options::LaunchOptions;
use crate::{AppInfo, AppPresentation, ErrorCode, ProcessId};
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::time::Duration;

#[test]
fn cdp_launch_injects_both_the_port_and_the_loopback_address_switch() {
    let adapter = empty_cdp_adapter(true);
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 3_000,
        ..Default::default()
    };

    execute(
        LaunchArgs {
            app: "Fixture".into(),
            options,
        },
        &adapter,
    )
    .unwrap();

    let captured_options = adapter.captured_options.lock().unwrap();
    let port = captured_options
        .cdp_port
        .expect("cdp_port resolved before launch_app ran");
    let captured_args = &captured_options.args;
    assert!(captured_args.contains(&format!("--remote-debugging-port={port}")));
    assert!(captured_args.contains(&"--remote-debugging-address=127.0.0.1".to_owned()));
}

#[test]
fn cdp_launch_rejects_a_conflicting_remote_debugging_address_switch() {
    let adapter = empty_cdp_adapter(false);
    let options = LaunchOptions {
        args: vec!["--remote-debugging-address=0.0.0.0".into()],
        cdp_port: Some(0),
        ..Default::default()
    };

    let error = adapter_error(
        execute(
            LaunchArgs {
                app: "Fixture".into(),
                options,
            },
            &adapter,
        )
        .unwrap_err(),
    );

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_switch_conflict"))
    );
}

#[test]
fn cdp_launch_rejects_a_conflicting_remote_allow_origins_switch() {
    let adapter = empty_cdp_adapter(false);
    let options = LaunchOptions {
        args: vec!["--remote-allow-origins=*".into()],
        cdp_port: Some(0),
        ..Default::default()
    };

    let error = adapter_error(
        execute(
            LaunchArgs {
                app: "Fixture".into(),
                options,
            },
            &adapter,
        )
        .unwrap_err(),
    );

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_switch_conflict"))
    );
}

/// The running-app precheck must also catch a match by bundle id, not only
/// by display name. Only workspace-registered apps (those with a
/// `presentation`) count as running instances, so `presentation` is set here.
#[test]
fn cdp_launch_rejects_an_already_running_instance_matched_by_bundle_id() {
    let adapter = CdpAdapter {
        running: vec![AppInfo {
            name: "Completely Different".into(),
            pid: ProcessId::new(9),
            bundle_id: Some("md.obsidian".into()),
            process_instance: Some("9:1".into()),
            presentation: Some(AppPresentation::Foreground),
        }],
        ..empty_cdp_adapter(false)
    };
    let options = LaunchOptions {
        cdp_port: Some(0),
        ..Default::default()
    };

    let error = adapter_error(
        execute(
            LaunchArgs {
                app: "md.obsidian".into(),
                options,
            },
            &adapter,
        )
        .unwrap_err(),
    );

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_requires_fresh_launch"))
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("pids")),
        Some(&serde_json::json!([9]))
    );
}

#[test]
fn cdp_launch_rejects_a_busy_requested_port_without_ever_calling_launch() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let adapter = empty_cdp_adapter(false);
    let options = LaunchOptions {
        cdp_port: Some(port),
        ..Default::default()
    };

    let error = adapter_error(
        execute(
            LaunchArgs {
                app: "Fixture".into(),
                options,
            },
            &adapter,
        )
        .unwrap_err(),
    );

    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_port_in_use"))
    );
    assert_eq!(adapter.launch_app_calls.load(Ordering::SeqCst), 0);
    drop(listener);
}

/// The probe's own error already carries `kind`, `port`, and `elapsed_ms`;
/// verification must layer `pid`, `process_instance`, and `probe_budget_ms`
/// onto that same error rather than rebuild a second one, and the message
/// must report what was observed (no answer) rather than claim the app
/// never opened the endpoint, which cannot be known from the outside.
#[test]
fn cdp_launch_verification_failure_carries_the_probes_details_merged_with_launch_context() {
    let adapter = empty_cdp_adapter(false);
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 200,
        ..Default::default()
    };

    let error = adapter_error(
        execute(
            LaunchArgs {
                app: "Fixture".into(),
                options,
            },
            &adapter,
        )
        .unwrap_err(),
    );

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error
            .message
            .contains("No DevTools endpoint answered on port")
    );
    assert!(!error.message.contains("never opened"));
    let details = error.details.as_ref().expect("failure carries details");
    assert_eq!(
        details.get("kind"),
        Some(&serde_json::json!("cdp_endpoint_unavailable"))
    );
    assert!(details.get("port").is_some());
    assert!(details.get("elapsed_ms").is_some());
    assert_eq!(details.get("pid"), Some(&serde_json::json!(42)));
    assert_eq!(
        details.get("process_instance"),
        Some(&serde_json::json!("42:1"))
    );
    assert!(details.get("probe_budget_ms").is_some());
}

#[test]
fn probe_reserve_is_zero_for_a_zero_budget() {
    assert_eq!(
        probe_reserve(Duration::from_millis(0)),
        Duration::from_millis(0)
    );
}

#[test]
fn probe_reserve_is_a_quarter_of_a_small_budget() {
    assert_eq!(
        probe_reserve(Duration::from_millis(400)),
        Duration::from_millis(100)
    );
}

#[test]
fn probe_reserve_is_capped_at_five_seconds_for_a_large_budget() {
    assert_eq!(
        probe_reserve(Duration::from_secs(40)),
        Duration::from_millis(5_000)
    );
}
