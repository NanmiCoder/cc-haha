use super::*;
use crate::system::window::cg_window::WindowRecord;

fn record(app_name: &str, pid: i32, title: &str, window_number: i64) -> WindowRecord {
    WindowRecord {
        app_name: app_name.into(),
        pid,
        title: Some(title.into()),
        window_number,
        bounds: agent_desktop_core::Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        visible: true,
        process_instance: Some(instance(pid)),
    }
}

fn win(id: &str, pid: i32, title: &str) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: title.into(),
        app: "TextEdit".into(),
        pid: agent_desktop_core::ProcessId::try_from(pid).unwrap(),
        process_instance: Some(instance(pid)),
        bounds: None,
        state: agent_desktop_core::WindowState::default(),
    }
}

fn current_pid() -> i32 {
    i32::try_from(std::process::id()).unwrap()
}

fn instance(pid: i32) -> String {
    if pid != current_pid() {
        return format!("instance-{pid}");
    }
    crate::system::process::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("current test process has an identity token")
}

#[test]
fn parse_window_number_accepts_w_prefix() {
    assert_eq!(parse_window_number("w-42"), Some(42));
    assert_eq!(parse_window_number("w-0"), None);
    assert_eq!(parse_window_number("w--1"), None);
    assert_eq!(parse_window_number("42"), None);
    assert_eq!(parse_window_number("w-bad"), None);
}

#[test]
fn verify_rejects_recycled_id_with_wrong_pid() {
    let requested = win("w-100", 10, "Untitled");
    let live = record("TextEdit", 99, "Untitled", 100);
    assert!(verify_window_record(&requested, &live).is_err());
}

#[test]
fn verify_rejects_recycled_pid_with_wrong_application_identity() {
    let pid = current_pid();
    let requested = win("w-100", pid, "Untitled");
    let live = record("DifferentApp", pid, "Untitled", 100);

    assert!(verify_window_record(&requested, &live).is_err());
}

#[test]
fn verify_rejects_title_mismatch_when_title_provided() {
    let pid = current_pid();
    let requested = win("w-100", pid, "Doc A");
    let live = record("TextEdit", pid, "Doc B", 100);
    assert!(verify_window_record(&requested, &live).is_err());
}

#[test]
fn verify_accepts_matching_pid_and_title() {
    let pid = current_pid();
    let requested = win("w-100", pid, "Untitled");
    let live = record("TextEdit", pid, "Untitled", 100);
    assert!(verify_window_record(&requested, &live).is_ok());
}

#[test]
fn resolved_window_preserves_verified_core_graphics_bounds() {
    let requested = win("w-100", 10, "Untitled");
    let live = record("TextEdit", 10, "Untitled", 100);

    let resolved = window_info_from_record(&requested, &live).unwrap();

    assert_eq!(resolved.bounds, Some(live.bounds));
}

#[test]
fn capture_verification_rejects_expired_deadline_before_native_reads() {
    let requested = win("w-100", 10, "Untitled");
    let error = resolve_capture_window(&requested, std::time::Instant::now())
        .expect_err("expired capture verification");

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn source_identity_survives_window_move_and_resize() {
    let pid = current_pid();
    let mut live = record("TextEdit", pid, "Untitled", 100);
    let original_hash = live.bounds.bounds_hash();
    live.bounds.x += 50.0;
    live.bounds.width += 25.0;
    live.title = Some("Renamed document".into());
    live.visible = false;
    let process_instance = instance(pid);

    assert!(window_record_matches_source(
        &live,
        &WindowIdentityEvidence {
            pid,
            app: Some("TextEdit"),
            process_instance: Some(process_instance.as_str()),
            title: Some("Untitled"),
            bounds_hash: original_hash,
        },
    ));
}

#[test]
fn source_identity_still_rejects_pid_and_application_mismatch() {
    let pid = current_pid();
    let live = record("TextEdit", pid, "Untitled", 100);

    assert!(!window_record_matches_source(
        &live,
        &WindowIdentityEvidence {
            pid: pid + 1,
            app: Some("TextEdit"),
            process_instance: Some(instance(pid).as_str()),
            title: Some("Untitled"),
            bounds_hash: None,
        },
    ));
    assert!(!window_record_matches_source(
        &live,
        &WindowIdentityEvidence {
            pid,
            app: Some("DifferentApp"),
            process_instance: Some(instance(pid).as_str()),
            title: Some("Untitled"),
            bounds_hash: None,
        },
    ));
}

#[test]
fn source_identity_rejects_missing_or_changed_process_generation() {
    let pid = current_pid();
    let live = record("TextEdit", pid, "Untitled", 100);

    assert!(!window_record_matches_source(
        &live,
        &WindowIdentityEvidence {
            pid,
            app: Some("TextEdit"),
            process_instance: None,
            title: Some("Untitled"),
            bounds_hash: None,
        },
    ));
    assert!(!window_record_matches_source(
        &live,
        &WindowIdentityEvidence {
            pid,
            app: Some("TextEdit"),
            process_instance: Some("different-generation"),
            title: Some("Untitled"),
            bounds_hash: None,
        },
    ));
}

#[test]
fn verify_skips_title_when_request_title_empty() {
    let pid = current_pid();
    let requested = WindowInfo {
        id: "w-100".into(),
        title: String::new(),
        app: "TextEdit".into(),
        pid: agent_desktop_core::ProcessId::try_from(pid).unwrap(),
        process_instance: Some(instance(pid)),
        bounds: None,
        state: agent_desktop_core::WindowState::default(),
    };
    let live = record("TextEdit", pid, "Any Title", 100);
    assert!(verify_window_record(&requested, &live).is_ok());
}

/// `list-windows` reports the CoreGraphics inventory, which includes windows an
/// application never publishes through accessibility. Calling those missing
/// contradicts the inventory that just handed out the id.
#[test]
fn a_window_without_an_accessibility_element_is_not_reported_as_missing() {
    let error = super::window_not_accessible("w-82");

    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::ActionNotSupported
    );
    assert!(error.message.contains("exists"));
    assert_ne!(error.code, agent_desktop_core::ErrorCode::WindowNotFound);
}
