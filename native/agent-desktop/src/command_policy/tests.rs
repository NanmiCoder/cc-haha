use super::*;
use crate::cli::Commands;
use crate::cli_args::{
    RefArgs, ScreenshotArgs, SnapshotArgs, WindowScope, snapshot_tree::SnapshotTreeArgs,
};
use agent_desktop_core::{PermissionReport, PermissionState};

const VALID_REF_ID: &str = "@s8f3k2p9:e1";

#[test]
fn permission_report_is_collected_only_for_permission_consumers() {
    let status = Commands::Status;
    let list_displays = Commands::ListDisplays;
    let batch = Commands::Batch(crate::cli_args::batch::BatchArgs {
        commands_json: "[]".into(),
        stop_on_error: false,
        timeout_ms: 1,
    });
    let open_system_surface =
        Commands::OpenSystemSurface(crate::cli_args::system::OpenSystemSurfaceArgs {
            surface: crate::cli_args::Surface::ActionCenter,
        });

    assert!(requires_permission_report(&status));
    assert!(requires_permission_report(&batch));
    assert!(requires_permission_report(&open_system_surface));
    assert!(!requires_permission_report(&list_displays));
}

#[test]
fn unknown_permission_does_not_mask_platform_errors() {
    let report = PermissionReport::default();
    let command = Commands::Screenshot(ScreenshotArgs {
        scope: WindowScope {
            app: None,
            window_id: None,
        },
        screen: None,
        output_path: None,
    });

    assert!(preflight(&command, &report).is_ok());
}

#[test]
fn screen_recording_denial_is_preflighted() {
    let report = PermissionReport {
        accessibility: PermissionState::Granted,
        screen_recording: PermissionState::Denied {
            suggestion: "grant screen recording".into(),
        },
        automation: PermissionState::NotRequired,
    };
    let command = Commands::Screenshot(ScreenshotArgs {
        scope: WindowScope {
            app: None,
            window_id: None,
        },
        screen: None,
        output_path: None,
    });

    let err = preflight(&command, &report).expect_err("denied screen capture fails");

    assert_eq!(err.code(), "PERM_DENIED");
}

#[test]
fn accessibility_denial_is_preflighted_for_ax_commands() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "grant accessibility".into(),
        },
        screen_recording: PermissionState::Granted,
        automation: PermissionState::NotRequired,
    };
    let command = Commands::Click(crate::cli_args::RefArgs {
        ref_id: VALID_REF_ID.into(),
        timeout_ms: 5000,
    });

    let err = preflight(&command, &report).expect_err("denied accessibility fails");

    assert_eq!(err.code(), "PERM_DENIED");
    assert_eq!(err.suggestion(), Some("grant accessibility"));
}

#[test]
fn invalid_ref_args_are_rejected_before_permission_preflight() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "grant accessibility".into(),
        },
        screen_recording: PermissionState::Granted,
        automation: PermissionState::NotRequired,
    };
    let command = Commands::Click(RefArgs {
        ref_id: "bad-ref".into(),
        timeout_ms: 5000,
    });

    let err = preflight(&command, &report).expect_err("invalid ref fails first");

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn invalid_snapshot_root_is_rejected_before_permission_preflight() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "grant accessibility".into(),
        },
        screen_recording: PermissionState::Granted,
        automation: PermissionState::NotRequired,
    };
    let command = Commands::Snapshot(SnapshotArgs {
        scope: WindowScope {
            app: None,
            window_id: None,
        },
        tree: SnapshotTreeArgs {
            max_depth: 10,
            include_bounds: false,
            interactive_only: false,
            compact: false,
            skeleton: false,
        },
        surface: crate::cli_args::Surface::Window,
        root: Some("bad-root".into()),
        timeout_ms: None,
        force_electron_a11y: false,
    });

    let err = preflight(&command, &report).expect_err("invalid root fails first");

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn notification_identity_is_required_before_permission_preflight() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "grant accessibility".into(),
        },
        screen_recording: PermissionState::Granted,
        automation: PermissionState::NotRequired,
    };
    let command =
        Commands::NotificationAction(crate::cli_args::notifications::NotificationActionCliArgs {
            index: 1,
            action: "Reply".into(),
            expected_app: None,
            expected_title: None,
        });

    let error = preflight(&command, &report).unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGS");
}

#[test]
fn dismiss_notification_identity_is_required_before_permission_preflight() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "grant accessibility".into(),
        },
        screen_recording: PermissionState::Granted,
        automation: PermissionState::NotRequired,
    };
    for (expected_app, expected_title) in [(None, None), (Some(String::new()), None)] {
        let command = Commands::DismissNotification(
            crate::cli_args::notifications::DismissNotificationCliArgs {
                index: 1,
                app: None,
                expected_app,
                expected_title,
            },
        );

        let error = preflight(&command, &report).expect_err("identity fails before permission");

        assert_eq!(error.code(), "INVALID_ARGS");
        assert!(error.to_string().contains("--expected-app"));
    }
}

#[test]
fn trace_show_passes_preflight_with_permissions_denied() {
    let report = PermissionReport {
        accessibility: PermissionState::Denied {
            suggestion: "denied".into(),
        },
        screen_recording: PermissionState::Denied {
            suggestion: "denied".into(),
        },
        automation: PermissionState::Denied {
            suggestion: "denied".into(),
        },
    };
    let command = Commands::Trace(crate::cli_args::trace::TraceArgs {
        action: crate::cli_args::trace::TraceAction::Show(crate::cli_args::trace::TraceShowArgs {
            limit: 500,
            event: None,
        }),
    });
    assert!(preflight(&command, &report).is_ok());
}

#[test]
fn a_multi_agent_desktop_action_needs_an_agent_id_on_every_platform() {
    let click = Commands::Click(RefArgs {
        ref_id: VALID_REF_ID.into(),
        timeout_ms: 5000,
    });

    assert!(agent_id_missing(&click, true, None));
    assert!(!agent_id_missing(&click, true, Some("agent-a")));
    assert!(!agent_id_missing(&click, false, None));
    assert!(!agent_id_missing(&Commands::Status, true, None));
}
