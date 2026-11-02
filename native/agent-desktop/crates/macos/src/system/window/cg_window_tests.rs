use super::*;

#[test]
fn missing_optional_owner_name_does_not_block_scoped_windows() {
    use core_foundation::{base::TCFType, number::CFNumber};

    let unnamed = CFDictionary::from_CFType_pairs(&[
        (
            CFString::new("kCGWindowLayer"),
            CFNumber::from(0).as_CFType(),
        ),
        (
            CFString::new("kCGWindowOwnerPID"),
            CFNumber::from(418).as_CFType(),
        ),
        (
            CFString::new("kCGWindowNumber"),
            CFNumber::from(8).as_CFType(),
        ),
    ]);
    let bounds = CFDictionary::from_CFType_pairs(&[
        (CFString::new("X"), CFNumber::from(0).as_CFType()),
        (CFString::new("Y"), CFNumber::from(0).as_CFType()),
        (CFString::new("Width"), CFNumber::from(100).as_CFType()),
        (CFString::new("Height"), CFNumber::from(100).as_CFType()),
    ]);
    let named = CFDictionary::from_CFType_pairs(&[
        (
            CFString::new("kCGWindowLayer"),
            CFNumber::from(0).as_CFType(),
        ),
        (
            CFString::new("kCGWindowOwnerPID"),
            CFNumber::from(10).as_CFType(),
        ),
        (
            CFString::new("kCGWindowNumber"),
            CFNumber::from(7).as_CFType(),
        ),
        (
            CFString::new("kCGWindowOwnerName"),
            CFString::new("Target").as_CFType(),
        ),
        (CFString::new("kCGWindowBounds"), bounds.as_CFType()),
    ]);

    let records =
        records_from_dictionaries(vec![unnamed.clone(), named], WindowRecordScope::Pid(10))
            .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].app_name, "Target");
    assert!(
        records_from_dictionaries(vec![unnamed], WindowRecordScope::Pid(418))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn expired_cg_window_deadline_is_rejected_before_native_reads() {
    let error = window_records_until(Instant::now(), WindowRecordScope::Pid(1)).unwrap_err();

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

#[test]
fn deadline_expired_before_any_capture_omits_the_unstable_inventory_kind() {
    let error = window_records_until(Instant::now(), WindowRecordScope::Pid(1)).unwrap_err();

    assert!(error.details.is_none());
}

#[test]
fn expired_deadline_before_any_attempt_is_a_plain_timeout() {
    let error = expired_deadline_error(0, 0, None);

    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.details.is_none());
}

#[test]
fn expired_deadline_after_attempts_still_reports_unstable_inventory() {
    let error = expired_deadline_error(3, 2, None);

    let details = error.details.unwrap();
    assert_eq!(details["kind"], "core_graphics_window_inventory_unstable");
    assert_eq!(details["attempts"], 3);
    assert_eq!(details["churn_events"], 2);
}

#[test]
fn malformed_cg_window_data_is_a_retryable_source_failure() {
    let error = missing_field_error("kCGWindowNumber");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    let details = error.details.unwrap();
    assert_eq!(details["source"], "core_graphics_windows");
    assert_eq!(details["retryable"], true);
}

#[test]
fn inventory_includes_offscreen_and_minimized_windows() {
    let options = window_list_options();

    assert_eq!(
        options & core_graphics::window::kCGWindowListOptionOnScreenOnly,
        0
    );
}

#[test]
fn changing_inventory_retries_until_two_consecutive_captures_match() {
    let mut attempt = 0;
    let stable = records_fixture(true);
    let result =
        stabilize_records_until(Instant::now() + std::time::Duration::from_secs(1), || {
            attempt += 1;
            Ok(if attempt == 1 {
                records_fixture(false)
            } else {
                stable.clone()
            })
        })
        .unwrap();

    assert_eq!(attempt, 3);
    assert_eq!(result, stable);
}

#[test]
fn persistent_window_churn_times_out_with_exact_attempt_metrics() {
    let mut visible = false;
    let mut attempts = 0_u64;
    let error = stabilize_records_until(
        Instant::now() + std::time::Duration::from_millis(20),
        || {
            attempts += 1;
            visible = !visible;
            Ok(records_fixture(visible))
        },
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert!(attempts >= 1);
    assert_eq!(details["attempts"].as_u64(), Some(attempts));
    assert_eq!(
        details["churn_events"].as_u64(),
        Some(attempts.saturating_sub(1))
    );
}

#[test]
fn scoped_capture_never_probes_an_unrelated_inaccessible_owner() {
    let eligible = rustc_hash::FxHashSet::from_iter([10]);
    let mut records = scoped_records(
        vec![
            window_dictionary("Target", 10, 7, true),
            window_dictionary("Other", 418, 8, true),
        ],
        WindowRecordScope::Pids(&eligible),
    );
    let mut probed = Vec::new();

    capture_process_instances_with(
        &mut records,
        Instant::now() + std::time::Duration::from_secs(1),
        |pid| {
            probed.push(pid);
            if pid == 418 {
                Err(AdapterError::permission_denied())
            } else {
                Ok(Some(format!("instance-{pid}")))
            }
        },
    )
    .unwrap();

    assert_eq!(probed, [10]);
    assert_eq!(records[0].process_instance.as_deref(), Some("instance-10"));
}

#[test]
fn scoped_capture_propagates_the_selected_owners_denial() {
    let mut records = vec![record("Target", 418, 8, true)];
    let error = capture_process_instances_with(
        &mut records,
        Instant::now() + std::time::Duration::from_secs(1),
        |_| Err(AdapterError::permission_denied()),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermDenied);
}

#[test]
fn pid_set_scope_keeps_all_matching_processes_and_ignores_unrelated_churn() {
    let eligible = rustc_hash::FxHashSet::from_iter([10, 11]);
    let scope = WindowRecordScope::Pids(&eligible);
    let first = scoped_records(
        vec![
            window_dictionary("Target", 10, 7, true),
            window_dictionary("Other", 20, 8, false),
            window_dictionary("Target", 11, 9, true),
        ],
        scope,
    );
    let second = scoped_records(
        vec![
            window_dictionary("Target", 10, 7, true),
            window_dictionary("Other", 20, 8, true),
            window_dictionary("Target", 11, 9, true),
        ],
        scope,
    );

    assert_eq!(first.len(), 2);
    assert_eq!(inventory_signature(&first), inventory_signature(&second));
}

#[test]
fn pid_and_window_scopes_exclude_unrelated_owners_before_identity_reads() {
    for scope in [WindowRecordScope::Pid(10), WindowRecordScope::Window(7)] {
        let mut records = scoped_records(
            vec![
                window_dictionary("Target", 10, 7, true),
                window_dictionary("Other", 20, 8, true),
            ],
            scope,
        );
        let mut probed = Vec::new();
        capture_process_instances_with(
            &mut records,
            Instant::now() + std::time::Duration::from_secs(1),
            |pid| {
                probed.push(pid);
                Ok(Some(format!("instance-{pid}")))
            },
        )
        .unwrap();

        assert_eq!(probed, [10]);
    }
}

#[test]
fn pid_set_scope_excludes_ineligible_owners_before_identity_reads() {
    let eligible = rustc_hash::FxHashSet::from_iter([10, 11]);
    let mut records = scoped_records(
        vec![
            window_dictionary("Target", 10, 7, true),
            window_dictionary("Accessory", 11, 8, true),
            window_dictionary("Protected", 418, 9, true),
        ],
        WindowRecordScope::Pids(&eligible),
    );
    let mut probed = Vec::new();

    capture_process_instances_with(
        &mut records,
        Instant::now() + std::time::Duration::from_secs(1),
        |pid| {
            probed.push(pid);
            if pid == 418 {
                Err(AdapterError::permission_denied())
            } else {
                Ok(Some(format!("instance-{pid}")))
            }
        },
    )
    .unwrap();

    assert_eq!(probed, [10, 11]);
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].process_instance.as_deref(), Some("instance-10"));
    assert_eq!(records[1].process_instance.as_deref(), Some("instance-11"));
}

#[test]
fn target_churn_remains_visible_after_scoping() {
    let eligible = rustc_hash::FxHashSet::from_iter([10]);
    let scope = WindowRecordScope::Pids(&eligible);
    let first = scoped_records(vec![window_dictionary("Target", 10, 7, false)], scope);
    let second = scoped_records(vec![window_dictionary("Target", 10, 7, true)], scope);

    assert_eq!(first.len(), 1);
    assert_ne!(inventory_signature(&first), inventory_signature(&second));
}

#[test]
fn unfiltered_capture_remains_fail_closed() {
    let mut records = vec![record("Target", 10, 7, true), record("Other", 418, 8, true)];
    let error = capture_process_instances_with(
        &mut records,
        Instant::now() + std::time::Duration::from_secs(1),
        |pid| {
            if pid == 418 {
                Err(AdapterError::permission_denied())
            } else {
                Ok(Some(format!("instance-{pid}")))
            }
        },
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermDenied);
}

fn records_fixture(visible: bool) -> Vec<WindowRecord> {
    vec![record("Fixture", 1, 7, visible)]
}

fn scoped_records(
    dictionaries: Vec<WindowDictionary>,
    scope: WindowRecordScope<'_>,
) -> Vec<WindowRecord> {
    records_from_dictionaries(dictionaries, scope).unwrap()
}

fn window_dictionary(
    app_name: &str,
    pid: i32,
    window_number: i64,
    visible: bool,
) -> WindowDictionary {
    use core_foundation::{base::TCFType, boolean::CFBoolean, number::CFNumber};

    let bounds = CFDictionary::from_CFType_pairs(&[
        (CFString::new("X"), CFNumber::from(0).as_CFType()),
        (CFString::new("Y"), CFNumber::from(0).as_CFType()),
        (CFString::new("Width"), CFNumber::from(100).as_CFType()),
        (CFString::new("Height"), CFNumber::from(100).as_CFType()),
    ]);
    CFDictionary::from_CFType_pairs(&[
        (
            CFString::new("kCGWindowLayer"),
            CFNumber::from(0).as_CFType(),
        ),
        (
            CFString::new("kCGWindowOwnerPID"),
            CFNumber::from(pid).as_CFType(),
        ),
        (
            CFString::new("kCGWindowNumber"),
            CFNumber::from(window_number).as_CFType(),
        ),
        (
            CFString::new("kCGWindowOwnerName"),
            CFString::new(app_name).as_CFType(),
        ),
        (
            CFString::new("kCGWindowIsOnscreen"),
            CFBoolean::from(visible).as_CFType(),
        ),
        (CFString::new("kCGWindowBounds"), bounds.as_CFType()),
    ])
}

fn record(app_name: &str, pid: i32, window_number: i64, visible: bool) -> WindowRecord {
    WindowRecord {
        app_name: app_name.into(),
        pid,
        title: Some("Window".into()),
        window_number,
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
        visible,
        process_instance: Some(format!("instance-{pid}")),
    }
}

#[test]
fn persistent_capture_failure_is_not_window_churn() {
    let mut attempts = 0;
    let error = stabilize_records_until(
        Instant::now() + std::time::Duration::from_millis(20),
        || {
            attempts += 1;
            Err(inventory_error("unavailable"))
        },
    )
    .unwrap_err();
    let details = error.details.unwrap();
    assert_eq!(details["attempts"], attempts);
    assert_eq!(details["churn_events"], 0);
    assert_eq!(
        details["last_failure_details"]["source"],
        "core_graphics_windows"
    );
}
