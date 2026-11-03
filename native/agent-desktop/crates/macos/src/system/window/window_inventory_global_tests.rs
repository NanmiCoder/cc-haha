use super::timeout_tests::{UNCONSUMED_BUDGET, fail_until_the_third_attempt};
use super::*;
use agent_desktop_core::Rect;
use rustc_hash::FxHashMap;

#[path = "window_inventory_global_focus_tests.rs"]
mod focus;

#[derive(Clone)]
struct Owners {
    launches: FxHashMap<i32, Option<f64>>,
    frontmost: Option<i32>,
}

impl OwnerSnapshotView for Owners {
    fn eligible_pids(&self) -> FxHashSet<i32> {
        self.launches.keys().copied().collect()
    }

    fn generation(&self, pid: i32) -> Option<OwnerGeneration> {
        self.launches.get(&pid).map(|launch| match launch {
            Some(launch_time) => OwnerGeneration::LaunchTime(*launch_time),
            None => OwnerGeneration::LiveProcess,
        })
    }

    fn frontmost_pid(&self) -> Option<i32> {
        self.frontmost
    }

    fn same_generation(&self, other: &Self) -> bool {
        self.launches == other.launches && self.frontmost == other.frontmost
    }
}

#[test]
fn background_owner_is_never_ax_probed_and_has_unknown_minimized_state() {
    let owners = owners(&[(10, 100.0), (20, 200.0)], Some(10));
    let records = vec![record(10, 1, "Front"), record(20, 2, "Background")];
    let mut probes = Vec::new();

    let windows = assemble_global_windows(records, &owners, false, |pid| {
        probes.push(pid);
        if pid == 20 {
            return Err(AdapterError::permission_denied());
        }
        Ok(ax_state(Some((Some("Front".into()), Some(1)))))
    })
    .unwrap();

    assert_eq!(probes, [10]);
    assert!(windows[0].state.is_focused);
    assert!(!windows[1].state.is_focused);
    assert_eq!(windows[1].state.minimized, None);
}

#[test]
fn windowless_owner_without_launch_date_does_not_poison_inventory() {
    let owners = Owners {
        launches: FxHashMap::from_iter([(10, Some(100.0)), (20, None)]),
        frontmost: Some(10),
    };
    let records = vec![record(10, 1, "Front")];
    let mut probes = Vec::new();

    let windows = assemble_global_windows(records, &owners, false, |pid| {
        probes.push(pid);
        Ok(ax_state(Some((Some("Front".into()), Some(1)))))
    })
    .unwrap();

    assert_eq!(probes, [10]);
    assert_eq!(windows.len(), 1);
}

#[test]
fn window_owner_without_launch_date_uses_live_process_generation() {
    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    let process_instance = crate::system::process::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("current process token");
    let owners = Owners {
        launches: FxHashMap::from_iter([(pid, None)]),
        frontmost: None,
    };
    let records = vec![WindowRecord {
        app_name: "Current".into(),
        pid,
        title: Some("Current".into()),
        window_number: 1,
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
        visible: true,
        process_instance: Some(process_instance),
    }];

    let windows = assemble_global_windows(records, &owners, false, |_| {
        panic!("no AX probe without a frontmost owner")
    })
    .unwrap();

    assert_eq!(windows.len(), 1);
}

#[test]
fn live_generation_rejects_stale_tokens() {
    let pid = i32::try_from(std::process::id()).expect("test pid fits macOS pid_t");
    let process_instance = crate::system::process::process_identity::token_for_pid(pid)
        .unwrap()
        .expect("current process token");
    let mut parts = process_instance.split(':');
    let prefix = parts.next().unwrap();
    let seconds = parts.next().unwrap().parse::<u64>().unwrap();
    let microseconds = parts.next().unwrap();
    let stale = format!("{prefix}:{}:{microseconds}", seconds + 1);
    let owners = Owners {
        launches: FxHashMap::from_iter([(pid, None)]),
        frontmost: None,
    };
    let mut stale_record = record(pid, 1, "Current");
    stale_record.process_instance = Some(stale);

    let error = assemble_global_windows(vec![stale_record], &owners, false, |_| {
        panic!("no AX probe without a frontmost owner")
    })
    .unwrap_err();

    assert_eq!(
        error.details.unwrap()["phase"],
        "process_generation_changed"
    );
}

#[test]
fn duplicate_windows_share_one_consistent_process_instance() {
    let records = vec![record(10, 1, "One"), record(10, 2, "Two")];
    let instances = unique_process_instances(&records).unwrap();

    assert_eq!(instances, [(10, "macos-proc-v1:100:0")]);

    let mut conflicting = records;
    conflicting[1].process_instance = Some("macos-proc-v1:101:0".into());
    let error = unique_process_instances(&conflicting).unwrap_err();
    assert_eq!(error.details.unwrap()["phase"], "process_instance_conflict");
}

#[test]
fn focused_only_returns_one_authoritatively_joined_window() {
    let owners = owners(&[(10, 100.0), (20, 200.0)], Some(10));
    let records = vec![record(10, 1, "Front"), record(20, 2, "Background")];

    let windows = assemble_global_windows(records, &owners, true, |_| {
        Ok(ax_state(Some((Some("Front".into()), Some(1)))))
    })
    .unwrap();

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].pid, 10);
    assert!(windows[0].state.is_focused);
}

#[test]
fn ineligible_owner_is_rejected_before_ax_join() {
    let owners = owners(&[(10, 100.0)], Some(10));
    let mut probed = false;

    let error = assemble_global_windows(vec![record(418, 1, "Protected")], &owners, false, |_| {
        probed = true;
        Ok(ax_state(None))
    })
    .unwrap_err();

    assert!(!probed);
    assert_eq!(error.details.unwrap()["phase"], "owner_not_eligible");
}

#[test]
fn frontmost_ax_timeout_is_retryable_but_permission_denial_is_not_rewritten() {
    let owners = owners(&[(10, 100.0)], Some(10));
    let records = vec![record(10, 1, "Front")];
    let timeout = assemble_global_windows(records.clone(), &owners, false, |_| {
        Err(AdapterError::timeout("hung"))
    })
    .unwrap_err();
    let denied = assemble_global_windows(records, &owners, false, |_| {
        Err(AdapterError::permission_denied())
    })
    .unwrap_err();

    assert_eq!(timeout.code, ErrorCode::AppUnresponsive);
    assert_eq!(timeout.details.unwrap()["retryable"], true);
    assert_eq!(denied.code, ErrorCode::PermDenied);
}

#[test]
fn missing_focus_join_fails_incomplete() {
    let owners = owners(&[(10, 100.0)], Some(10));
    let records = vec![record(10, 1, "Solo")];

    let error = assemble_global_windows(records, &owners, false, |_| {
        Ok(ax_state(Some((Some("Solo".into()), Some(99)))))
    })
    .unwrap_err();

    assert_eq!(error.details.unwrap()["kind"], "frontmost_window_join");
}

#[test]
fn ambiguous_title_without_window_number_degrades_to_unconfirmed_focus() {
    let owners = owners(&[(10, 100.0)], Some(10));
    let records = vec![record(10, 1, "Duplicate"), record(10, 2, "Duplicate")];

    let windows = assemble_global_windows(records, &owners, false, |_| {
        Ok(ax_state(Some((Some("Duplicate".into()), None))))
    })
    .unwrap();

    assert_eq!(windows.len(), 2);
    assert!(windows.iter().all(|window| !window.state.is_focused));
}

#[test]
fn owner_snapshot_or_process_generation_churn_is_retryable() {
    let before = owners(&[(10, 100.0)], Some(10));
    let after = owners(&[(10, 106.0)], Some(10));
    let records = vec![record(10, 1, "Front")];

    let snapshot_error = validate_snapshot_pair(&before, &after, &records).unwrap_err();
    let generation_error = assemble_global_windows(records, &after, false, |_| {
        Ok(ax_state(Some((Some("Front".into()), Some(1)))))
    })
    .unwrap_err();

    assert_eq!(
        snapshot_error.details.unwrap()["phase"],
        "appkit_snapshot_changed"
    );
    assert_eq!(
        generation_error.details.unwrap()["phase"],
        "process_generation_changed"
    );
}

#[test]
fn stabilization_retries_churn_and_preserves_strict_failures() {
    let mut attempts = 0;
    let windows = stabilize_global_with(Instant::now() + UNCONSUMED_BUDGET, || {
        attempts += 1;
        if attempts == 1 {
            Err(owner_churn_error(None, "test"))
        } else {
            Ok(Vec::new())
        }
    })
    .unwrap();

    assert!(windows.is_empty());
    assert_eq!(attempts, 2);
    let denied = stabilize_global_with(Instant::now() + UNCONSUMED_BUDGET, || {
        Err(AdapterError::permission_denied())
    })
    .unwrap_err();
    assert_eq!(denied.code, ErrorCode::PermDenied);
}

#[test]
fn persistent_owner_churn_times_out_with_exact_attempt_metrics() {
    let mut attempts = 0_u64;
    let error = stabilize_global_with(Instant::now() + UNCONSUMED_BUDGET, || {
        fail_until_the_third_attempt(&mut attempts, || owner_churn_error(None, "test"))
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["attempts"], 3);
    assert_eq!(details["last_code"], "APP_UNRESPONSIVE");
    assert_eq!(details["last_kind"], "global_window_owner_churn");
}

#[test]
fn global_capture_orders_appkit_cg_ax_appkit_and_filters_before_cg() {
    let owners = owners(&[(10, 100.0), (20, 200.0)], Some(10));
    let events = std::cell::RefCell::new(Vec::new());
    let snapshot_count = std::cell::Cell::new(0);

    let windows = capture_global_with(
        false,
        || {
            let ordinal = snapshot_count.get();
            events
                .borrow_mut()
                .push(if ordinal == 0 { "a" } else { "b" });
            snapshot_count.set(ordinal + 1);
            Ok(owners.clone())
        },
        |eligible| {
            events.borrow_mut().push("cg");
            assert_eq!(eligible, &FxHashSet::from_iter([10, 20]));
            Ok(vec![record(10, 1, "Front")])
        },
        |_| {
            events.borrow_mut().push("ax");
            Ok(ax_state(Some((Some("Front".into()), Some(1)))))
        },
    )
    .unwrap();

    assert_eq!(&*events.borrow(), &["a", "cg", "ax", "b"]);
    assert_eq!(windows.len(), 1);
}

#[test]
fn post_ax_snapshot_is_captured_and_churn_wins_over_stale_ax_failure() {
    let snapshots = std::cell::RefCell::new(std::collections::VecDeque::from([
        owners(&[(10, 100.0)], Some(10)),
        owners(&[(10, 106.0)], Some(10)),
    ]));
    let snapshot_count = std::cell::Cell::new(0);

    let error = capture_global_with(
        false,
        || {
            snapshot_count.set(snapshot_count.get() + 1);
            Ok(snapshots.borrow_mut().pop_front().unwrap())
        },
        |_| Ok(vec![record(10, 1, "Front")]),
        |_| Err(AdapterError::permission_denied()),
    )
    .unwrap_err();

    assert_eq!(snapshot_count.get(), 2);
    assert_eq!(error.details.unwrap()["phase"], "appkit_snapshot_changed");
}

#[test]
fn scoped_pid_selection_is_still_bound_to_the_owner_generation() {
    let snapshots = std::cell::RefCell::new(std::collections::VecDeque::from([
        owners(&[(10, 100.0), (20, 200.0)], Some(10)),
        owners(&[(10, 106.0), (20, 200.0)], Some(10)),
    ]));

    let error = capture_stable_with(
        || Ok(snapshots.borrow_mut().pop_front().unwrap()),
        |_| FxHashSet::from_iter([10]),
        |selected| {
            assert_eq!(selected, &FxHashSet::from_iter([10]));
            Ok(vec![record(10, 1, "Target")])
        },
        |_, _| Ok(Vec::new()),
    )
    .unwrap_err();

    assert_eq!(error.details.unwrap()["phase"], "appkit_snapshot_changed");
}

fn owners(entries: &[(i32, f64)], frontmost: Option<i32>) -> Owners {
    Owners {
        launches: entries
            .iter()
            .map(|(pid, launch)| (*pid, Some(*launch)))
            .collect(),
        frontmost,
    }
}

fn record(pid: i32, window_number: i64, title: &str) -> WindowRecord {
    let launch = if pid == 10 { 100 } else { 200 };
    WindowRecord {
        app_name: format!("App-{pid}"),
        pid,
        title: Some(title.into()),
        window_number,
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
        visible: true,
        process_instance: Some(format!("macos-proc-v1:{launch}:0")),
    }
}

fn ax_state(focused: Option<(Option<String>, Option<i64>)>) -> WindowAxState {
    WindowAxState {
        focused,
        minimized_by_id: FxHashMap::default(),
        accessible_window_ids: FxHashSet::default(),
    }
}
