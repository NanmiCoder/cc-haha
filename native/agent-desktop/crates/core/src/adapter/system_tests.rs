use super::*;

struct DefaultOnly;
impl SystemOps for DefaultOnly {}

#[test]
fn default_interaction_lease_is_unsupported_in_test_builds_too() {
    let error = match DefaultOnly.acquire_interaction_lease(crate::Deadline::standard().unwrap()) {
        Ok(_) => panic!("default lease must fail closed"),
        Err(error) => error,
    };

    assert_eq!(error.code, crate::ErrorCode::PlatformNotSupported);
}

#[test]
fn default_surfaces_fail_closed() {
    assert!(DefaultOnly.supported_surfaces().is_empty());
}

#[test]
fn default_cursor_overlay_refuses_as_platform_not_supported() {
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    let instruction =
        crate::CursorOverlayInstruction::new(crate::Point { x: 20.0, y: 40.0 }, &config, true)
            .expect("valid instruction");
    let control = crate::CursorOverlayControl::present("test-session".into(), instruction);

    let error = match DefaultOnly.update_cursor_overlay(&control) {
        Ok(_) => panic!("default cursor overlay must fail closed"),
        Err(error) => error,
    };

    assert_eq!(error.code, crate::ErrorCode::PlatformNotSupported);
    assert!(DefaultOnly.run_cursor_overlay_child().is_none());
}

#[test]
fn default_permission_report_is_unknown_not_denied() {
    let report = DefaultOnly
        .permission_report(crate::Deadline::standard().unwrap())
        .expect("default permission report must not error");

    assert_eq!(report.accessibility, crate::PermissionState::Unknown);
    assert!(!report.accessibility_denied());
    assert!(DefaultOnly.unknown_accessibility_means_unsupported());
}

#[test]
fn default_open_session_is_explicitly_unsupported() {
    let affinity = crate::SessionAffinity {
        session_id: Some("test-session".into()),
    };
    let error = match DefaultOnly.open_session(&affinity, crate::Deadline::standard().unwrap()) {
        Ok(_) => panic!("default session affinity must fail closed"),
        Err(error) => error,
    };

    assert_eq!(error.code, crate::ErrorCode::PlatformNotSupported);
    assert!(error.message.contains("open_session"));
}
