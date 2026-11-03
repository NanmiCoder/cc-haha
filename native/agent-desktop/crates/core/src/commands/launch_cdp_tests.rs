use super::cdp_test_support::{CdpAdapter, adapter_error, empty_cdp_adapter};
use super::*;
use crate::system::launch_options::LaunchOptions;
use crate::{AppInfo, AppPresentation, ErrorCode, ProcessId, RendererKind};
use std::sync::atomic::Ordering;

#[test]
fn cdp_launch_rejects_a_conflicting_remote_debugging_switch() {
    let adapter = empty_cdp_adapter(false);
    let options = LaunchOptions {
        args: vec!["--remote-debugging-port=1234".into()],
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
    assert_eq!(
        adapter.list_apps_calls.load(Ordering::SeqCst),
        0,
        "the switch conflict is rejected before the running-app precheck runs"
    );
}

#[test]
fn cdp_launch_rejects_an_already_running_instance() {
    let adapter = CdpAdapter {
        running: vec![AppInfo {
            name: "Fixture".into(),
            pid: ProcessId::new(7),
            bundle_id: None,
            process_instance: Some("7:1".into()),
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
                app: "Fixture".into(),
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
    assert_eq!(adapter.list_apps_calls.load(Ordering::SeqCst), 1);
}

/// A launch target given as a path must still find the running instance: the
/// whole path never equals the app's name, so without the stem the refusal
/// was skipped and the platform launch met the app's own processes instead.
#[test]
fn cdp_launch_rejects_a_running_instance_named_by_its_path() {
    let adapter = CdpAdapter {
        running: vec![AppInfo {
            name: "Obsidian.exe".into(),
            pid: ProcessId::new(7),
            bundle_id: None,
            process_instance: Some("7:1".into()),
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
                app: "/opt/Obsidian/Obsidian.exe".into(),
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
    assert_eq!(adapter.launch_app_calls.load(Ordering::SeqCst), 0);
}

/// `list_apps` also returns ps-derived helper processes: no bundle ID, no
/// presentation, because the adapter can never attach a launch to one. A
/// helper sharing the requested app's name must not block the launch.
#[test]
fn cdp_launch_ignores_a_name_matching_helper_process_without_presentation() {
    let adapter = CdpAdapter {
        running: vec![AppInfo {
            name: "Fixture".into(),
            pid: ProcessId::new(7),
            bundle_id: None,
            process_instance: None,
            presentation: None,
        }],
        ..empty_cdp_adapter(true)
    };
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 3_000,
        ..Default::default()
    };

    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options,
        },
        &adapter,
    )
    .expect("a presentation-less helper process must not block the launch");

    assert!(value.get("cdp").is_some());
}

/// Even when the endpoint never answers, the switch was already appended
/// and the resolved port already recorded before `launch_app` ran — the
/// failure is in verification, not in requesting the port.
#[test]
fn cdp_launch_appends_the_switch_and_resolves_the_port_before_verification_fails() {
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
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_endpoint_unavailable"))
    );
    let captured_options = adapter.captured_options.lock().unwrap();
    let captured_port = captured_options
        .cdp_port
        .expect("cdp_port was resolved before launch_app ran");
    let captured_args = &captured_options.args;
    assert!(captured_args.contains(&format!("--remote-debugging-port={captured_port}")));
}

#[test]
fn cdp_launch_returns_a_verified_endpoint_when_the_process_answers() {
    let adapter = empty_cdp_adapter(true);
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 3_000,
        ..Default::default()
    };

    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options,
        },
        &adapter,
    )
    .unwrap();

    let cdp = value
        .get("cdp")
        .expect("cdp endpoint present in the envelope");
    assert_eq!(
        cdp.get("product").and_then(Value::as_str),
        Some("Fixture/1.0")
    );
    assert!(
        cdp.get("websocket_url")
            .and_then(Value::as_str)
            .unwrap()
            .contains("devtools/browser")
    );
}

#[test]
fn cdp_launch_rejects_a_valid_devtools_response_from_an_unattributed_listener() {
    let adapter = CdpAdapter {
        attribute_cdp_listener: false,
        ..empty_cdp_adapter(true)
    };
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 3_000,
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
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind")),
        Some(&serde_json::json!("cdp_listener_unattributed"))
    );
    assert_eq!(
        error.disposition,
        crate::DeliverySemantics::DeliveredUnverified
    );
}

/// A Chromium app launched without `--cdp` gets nudged toward the flag that
/// actually opens the web-content door, without repeating that door's name.
#[test]
fn chromium_renderer_without_cdp_gets_the_relaunch_suggestion() {
    let adapter = CdpAdapter {
        renderer: Some(RendererKind::Chromium),
        ..empty_cdp_adapter(false)
    };

    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options: LaunchOptions::default(),
        },
        &adapter,
    )
    .unwrap();

    assert_eq!(
        value.get("renderer").and_then(Value::as_str),
        Some("chromium")
    );
    assert!(value.get("cdp").is_none());
    let suggestion = value
        .get("suggestion")
        .and_then(Value::as_str)
        .expect("suggestion present for an undriven chromium renderer");
    assert!(suggestion.contains("--cdp"));
}

#[test]
fn cdp_success_gets_the_handoff_suggestion() {
    let adapter = empty_cdp_adapter(true);
    let options = LaunchOptions {
        cdp_port: Some(0),
        timeout_ms: 3_000,
        ..Default::default()
    };

    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options,
        },
        &adapter,
    )
    .unwrap();

    assert!(value.get("cdp").is_some());
    let suggestion = value
        .get("suggestion")
        .and_then(Value::as_str)
        .expect("suggestion present once the endpoint is verified");
    assert!(suggestion.contains("agent-browser connect"));
    assert!(suggestion.contains("Do not hand-roll raw CDP"));
}

#[test]
fn non_chromium_plain_launch_has_neither_renderer_nor_suggestion() {
    let adapter = empty_cdp_adapter(false);

    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options: LaunchOptions::default(),
        },
        &adapter,
    )
    .unwrap();

    assert!(value.get("renderer").is_none());
    assert!(value.get("suggestion").is_none());
}

struct SuggestingAdapter;

impl crate::adapter::ObservationOps for SuggestingAdapter {}
impl crate::adapter::ActionOps for SuggestingAdapter {}
impl crate::adapter::InputOps for SuggestingAdapter {}

impl crate::adapter::SystemOps for SuggestingAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, crate::AdapterError> {
        crate::InteractionLease::guarded(deadline, ())
    }

    fn launch_app(
        &self,
        _id: &str,
        _options: &LaunchOptions,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::system::launch_result::LaunchResult, crate::AdapterError> {
        Ok(crate::system::launch_result::LaunchResult {
            app: "Fixture".into(),
            pid: crate::ProcessId::new(42),
            process_instance: None,
            window: None,
            cdp: None,
            renderer: Some(RendererKind::Chromium),
            suggestion: Some("adapter guidance".into()),
        })
    }
}

#[test]
fn adapter_suggestion_survives_the_core_chromium_nudge() {
    let value = execute(
        LaunchArgs {
            app: "Fixture".into(),
            options: LaunchOptions::default(),
        },
        &SuggestingAdapter,
    )
    .unwrap();

    assert_eq!(value["suggestion"], "adapter guidance");
}
