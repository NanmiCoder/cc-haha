use super::*;

#[test]
fn protected_processes_match_display_and_bundle_forms() {
    assert!(is_protected_process("Finder"));
    assert!(is_protected_process("Dock"));
    assert!(is_protected_process("com.apple.dock"));
    assert!(is_protected_process("WindowServer"));
    assert!(is_protected_process("loginwindow"));
}

#[test]
fn ordinary_apps_are_not_protected() {
    assert!(!is_protected_process("TextEdit"));
    assert!(!is_protected_process("Safari"));
    assert!(!is_protected_process("com.company.MyApp"));
}

#[test]
fn lookalike_names_containing_protected_substrings_stay_closable() {
    assert!(!is_protected_process("Docker"));
    assert!(!is_protected_process("Docker Desktop"));
    assert!(!is_protected_process("com.docker.docker-desktop"));
    assert!(!is_protected_process("FinderSync"));
    assert!(!is_protected_process("PathFinder"));
    assert!(!is_protected_process("launchdarkly-agent"));
}

#[test]
fn adapter_guard_refuses_protected_processes_with_the_cli_contract() {
    let err = ensure_not_protected("loginwindow").unwrap_err();

    assert_eq!(err.code, agent_desktop_core::ErrorCode::InvalidArgs);
    assert!(err.message.contains("protected"));
    assert!(err.suggestion.is_some());
    assert!(ensure_not_protected("TextEdit").is_ok());
}

#[test]
fn native_termination_rejection_does_not_blame_the_target_application() {
    let error = termination_request_not_accepted("Fixture", 42, false);

    assert_eq!(error.code, agent_desktop_core::ErrorCode::ActionFailed);
    assert!(
        error
            .message
            .contains("native termination API did not accept")
    );
    assert!(!error.message.contains("App 'Fixture' rejected"));
    assert_eq!(error.details.as_ref().unwrap()["pid"], 42);
    assert_eq!(error.details.as_ref().unwrap()["force"], false);
}

#[test]
fn adapter_close_without_a_process_instance_keeps_the_invalid_args_contract() {
    use agent_desktop_core::{InteractionLease, SystemOps};

    let app = AppInfo {
        name: "TextEdit".into(),
        pid: agent_desktop_core::ProcessId::new(42),
        bundle_id: None,
        process_instance: None,
        presentation: None,
    };
    let deadline = Deadline::detached_after(1_000).expect("deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");

    let error = crate::adapter::MacOSAdapter::new()
        .close_app(&app, false, &lease)
        .unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::InvalidArgs);
    assert!(error.message.contains("process instance"));
}
