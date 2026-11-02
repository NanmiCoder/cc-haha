use super::*;
use agent_desktop_core::{ErrorCode, Rect};
use std::cell::Cell;

#[test]
fn exact_window_capture_does_not_wait_for_unrelated_inventory_stability() {
    let captures = Cell::new(0_u32);
    let result = exact_window_record_until_with(
        7,
        Instant::now() + std::time::Duration::from_secs(1),
        || {
            captures.set(captures.get() + 1);
            if captures.get() == 1 {
                Ok(vec![record(10, 7, "instance-10")])
            } else {
                Ok(vec![record(10, 7, "instance-11")])
            }
        },
    )
    .unwrap()
    .unwrap();

    assert_eq!(captures.get(), 1);
    assert_eq!(result.window_number, 7);
}

#[test]
fn exact_window_capture_accepts_absence_without_broadening() {
    let result = exact_window_record_until_with(
        7,
        Instant::now() + std::time::Duration::from_secs(1),
        || Ok(Vec::new()),
    )
    .unwrap();

    assert!(result.is_none());
}

#[test]
fn exact_window_capture_rejects_multiple_records() {
    let error = exact_window_record_until_with(
        7,
        Instant::now() + std::time::Duration::from_secs(1),
        || {
            Ok(vec![
                record(10, 7, "instance-10"),
                record(10, 7, "instance-10"),
            ])
        },
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.details.unwrap()["kind"],
        "exact_window_inventory_source"
    );
}

#[test]
fn exact_window_capture_rejects_a_different_window_id() {
    let error = exact_window_record_until_with(
        7,
        Instant::now() + std::time::Duration::from_secs(1),
        || Ok(vec![record(10, 8, "instance-10")]),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

fn record(pid: i32, window_number: i64, process_instance: &str) -> WindowRecord {
    WindowRecord {
        app_name: "Fixture".into(),
        pid,
        title: Some("Window".into()),
        window_number,
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
        visible: true,
        process_instance: Some(process_instance.into()),
    }
}
