use super::*;

/// An expired budget is answered from the deadline alone.
///
/// The probe and the report builder are handed in as closures that panic if
/// they are ever entered, so "without native calls" is asserted rather than
/// inferred from the error code: a gate moved below the probe would still
/// report `TIMEOUT` while having already gone out to the COM runtime.
#[test]
fn expired_permission_deadline_fails_without_native_calls() {
    let error = report(Deadline::after(0).unwrap()).unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);

    let requested = request_report_with(
        Deadline::after(0).unwrap(),
        || panic!("an expired deadline must not reach the native UI Automation probe"),
        |_, _| panic!("an expired deadline must not reach the report builder"),
    )
    .unwrap_err();

    assert_eq!(requested.code, agent_desktop_core::ErrorCode::Timeout);
}

#[test]
fn uia_access_grant_and_denial_map_from_literal_hresults() {
    assert_eq!(map_uia_access(0), PermissionState::Granted);

    let PermissionState::Denied { suggestion } = map_uia_access(0x8007_0005_u32 as i32) else {
        panic!("E_ACCESSDENIED must map to a denial");
    };
    assert!(!suggestion.is_empty());
}

#[test]
fn unrecognised_hresults_map_to_unknown_never_a_guess() {
    assert_eq!(map_uia_access(1), PermissionState::Unknown);
    assert_eq!(map_uia_access(-1), PermissionState::Unknown);
    assert_eq!(
        map_uia_access(0x8000_4005_u32 as i32),
        PermissionState::Unknown
    );
    assert_eq!(
        map_uia_access(0x8001_0106_u32 as i32),
        PermissionState::Unknown
    );
}

#[test]
fn capture_availability_maps_only_what_is_wired_today() {
    assert_eq!(map_capture_availability(None), PermissionState::Unknown);
    assert_eq!(
        map_capture_availability(Some(true)),
        PermissionState::NotRequired
    );
    assert_eq!(
        map_capture_availability(Some(false)),
        PermissionState::Unknown
    );
}

#[test]
fn denial_platform_detail_matches_the_invariant_hresult_format() {
    let error = uia_access_denied_error(0x8007_0005_u32 as i32);

    assert_eq!(error.code, agent_desktop_core::ErrorCode::PermDenied);
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("COM HRESULT 0x80070005 (E_ACCESSDENIED: Access is denied)")
    );
    assert!(
        error
            .suggestion
            .is_some_and(|suggestion| !suggestion.is_empty())
    );
}

#[test]
fn unnamed_hresults_format_without_inventing_a_name() {
    assert_eq!(
        com_hresult_detail(0x8007_0002_u32 as i32),
        "COM HRESULT 0x80070002"
    );
    assert!(crate::system::runtime::hresult::com_hresult_symbol(0x8007_0002_u32 as i32).is_none());
}

#[test]
fn request_on_a_denied_probe_is_a_structured_error_not_a_prompt() {
    let error = request_report_with(
        Deadline::after(1_000).unwrap(),
        || 0x8007_0005_u32 as i32,
        |_, _| panic!("a denied probe must not fall through to the report"),
    )
    .unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::PermDenied);
    assert!(error.platform_detail.is_some());
}

#[test]
fn request_on_a_granted_probe_reports_accessibility_from_that_single_probe() {
    let report = request_report_with(
        Deadline::after(1_000).unwrap(),
        || 0,
        report_from_probed_uia,
    )
    .unwrap();

    assert_eq!(report.accessibility, PermissionState::Granted);
    assert_eq!(report.automation, PermissionState::NotRequired);
}

#[cfg(not(target_os = "windows"))]
#[test]
fn non_windows_arm_reports_the_canned_default_shape() {
    let report = report(Deadline::after(1_000).unwrap()).unwrap();

    assert_eq!(report.accessibility, PermissionState::Unknown);
    assert_eq!(report.screen_recording, PermissionState::Unknown);
    assert_eq!(report.automation, PermissionState::NotRequired);
}

#[cfg(target_os = "windows")]
#[test]
fn automation_is_not_required_on_windows() {
    let report = report(Deadline::after(5_000).unwrap()).unwrap();

    assert_eq!(report.automation, PermissionState::NotRequired);
}

#[cfg(target_os = "windows")]
#[test]
fn screen_recording_is_not_required_when_any_capture_backend_can_run() {
    crate::tree::fixture::bootstrap();
    let report = report(Deadline::after(5_000).unwrap()).unwrap();
    let probed = super::imp::probe_capture_availability();
    assert_eq!(report.screen_recording, map_capture_availability(probed));
    assert_eq!(
        report.screen_recording,
        PermissionState::NotRequired,
        "interactive sessions with a monitor can capture via Legacy even when WGC is unavailable"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn uia_probe_reaches_a_verdict_on_a_healthy_windows_session() {
    let report = report(Deadline::after(5_000).unwrap()).unwrap();

    assert!(matches!(
        report.accessibility,
        PermissionState::Granted | PermissionState::Denied { .. }
    ));
}
