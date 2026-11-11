use super::*;
use crate::system::window::cg_window::WindowRecord;
use agent_desktop_core::Rect;
use rustc_hash::FxHashMap;

#[derive(Clone)]
struct ScopedOwners(FxHashMap<i32, f64>);

impl crate::system::window::window_inventory_global::OwnerSnapshotView for ScopedOwners {
    fn eligible_pids(&self) -> rustc_hash::FxHashSet<i32> {
        self.0.keys().copied().collect()
    }

    fn generation(
        &self,
        pid: i32,
    ) -> Option<crate::system::window::window_inventory_global::OwnerGeneration> {
        self.0
            .get(&pid)
            .copied()
            .map(crate::system::window::window_inventory_global::OwnerGeneration::LaunchTime)
    }

    fn frontmost_pid(&self) -> Option<i32> {
        None
    }

    fn same_generation(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}

fn ax_state(
    focused: FocusedWindowIdentity,
) -> crate::system::window::window_ax_state::WindowAxState {
    crate::system::window::window_ax_state::WindowAxState {
        focused,
        minimized_by_id: FxHashMap::default(),
        accessible_window_ids: rustc_hash::FxHashSet::default(),
    }
}

#[test]
fn apps_from_window_records_deduplicates_by_pid() {
    let apps = apps_from_window_records(&[
        record("Finder", 10, "Window 1", 1),
        record("Finder", 10, "Window 2", 2),
    ]);

    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0].name, "Finder");
}

#[test]
fn apps_from_window_records_keeps_same_name_with_distinct_pids() {
    let apps = apps_from_window_records(&[
        record("Preview", 10, "Preview", 10),
        record("Preview", 11, "Preview", 11),
    ]);

    assert_eq!(apps.len(), 2);
}

#[test]
fn matches_app_filter_accepts_exact_case_insensitive_name() {
    assert!(matches_app_filter("Docker Desktop", "docker desktop"));
    assert!(matches_app_filter("\u{200e}WhatsApp", "WhatsApp"));
    assert!(!matches_app_filter("Finder", "docker"));
}

#[test]
fn matches_app_filter_rejects_substring_match() {
    assert!(!matches_app_filter("Mail Helper", "mail"));
}

#[test]
fn windows_from_records_marks_single_focused_window_once() {
    let windows = windows_from_records_with_focus(
        vec![
            record("Mail", 10, "Inbox", 1),
            record("Mail", 10, "Inbox", 2),
        ],
        false,
        |_| Ok(ax_state(Some((Some("Inbox".to_string()), Some(2))))),
        |_, _| Ok(true),
    )
    .unwrap();

    assert!(!windows[0].state.is_focused);
    assert!(windows[1].state.is_focused);
}

#[test]
fn windows_from_records_focus_only_filters_unfocused_windows() {
    let windows = windows_from_records_with_focus(
        vec![
            record("Mail", 10, "Inbox", 1),
            record("Mail", 10, "Sent", 2),
        ],
        true,
        |_| Ok(ax_state(Some((Some("Sent".to_string()), Some(2))))),
        |_, _| Ok(true),
    )
    .unwrap();

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].title, "Sent");
}

#[test]
fn windows_from_records_preserve_capture_bounds() {
    let expected = Rect {
        x: 12.0,
        y: 34.0,
        width: 800.0,
        height: 600.0,
    };
    let mut source = record("Preview", 10, "Document", 7);
    source.bounds = expected;

    let windows = windows_from_records_with_focus(
        vec![source],
        false,
        |_| Ok(ax_state(None)),
        |_, _| Ok(true),
    )
    .unwrap();

    assert_eq!(windows[0].bounds, Some(expected));
}

#[test]
fn cg_window_without_an_ax_element_is_labelled_inaccessible() {
    let windows = windows_from_records_with_focus(
        vec![record("Clock", 10, "Untitled", 7)],
        false,
        |_| Ok(ax_state(None)),
        |_, _| Ok(true),
    )
    .unwrap();

    let value = serde_json::to_value(&windows[0]).unwrap();
    assert_eq!(value["accessible"], false);
}

#[test]
fn visible_windows_survive_ax_inventory_failure() {
    let visible = record("Preview", 10, "Document", 7);
    let mut panel = record("Preview", 10, "Panel", 8);
    panel.visible = false;

    let mut windows = windows_from_records_with_focus(
        vec![visible, panel],
        false,
        |_| Err(AdapterError::timeout("AX unavailable")),
        |_, _| Ok(true),
    )
    .unwrap();
    narrow_to_real_windows(&mut windows);

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].id, "w-7");
}

#[test]
fn offscreen_only_inventory_requires_ax_classification() {
    let mut offscreen = record("Preview", 10, "Document", 7);
    offscreen.visible = false;

    let error = windows_from_records_with_focus(
        vec![offscreen],
        false,
        |_| Err(AdapterError::timeout("AX unavailable")),
        |_, _| Ok(true),
    )
    .unwrap_err();

    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
}

#[test]
fn windows_from_records_never_publish_zero_window_ids() {
    let windows = windows_from_records_with_focus(
        vec![record("Preview", 10, "Unverified", 0)],
        false,
        |_| Ok(ax_state(None)),
        |_, _| Ok(true),
    )
    .unwrap();

    assert!(windows.is_empty());
}

#[test]
fn window_inventory_rejects_owner_generation_change_around_focus_read() {
    let mut checks = 0;
    let error = windows_from_records_with_focus(
        vec![record("Preview", 10, "Document", 7)],
        false,
        |_| Ok(ax_state(None)),
        |_, _| {
            checks += 1;
            Ok(checks == 1)
        },
    )
    .expect_err("owner changed after AX join");

    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["kind"], "window_identity_race");
}

#[test]
fn matches_focused_window_uses_window_number_when_available() {
    let identity = Some((Some("Other".to_string()), Some(7)));

    assert!(matches_focused_window("Inbox", 7, &identity, 3));
    assert!(!matches_focused_window("Inbox", 8, &identity, 1));
}

#[test]
fn matches_focused_window_uses_unique_title_without_window_number() {
    let identity = Some((Some("Inbox".to_string()), None));

    assert!(matches_focused_window("Inbox", 0, &identity, 1));
    assert!(!matches_focused_window("Inbox", 0, &identity, 2));
    assert!(!matches_focused_window("Sent", 0, &identity, 1));
}

#[test]
fn deadline_window_inventory_rejects_expiry_before_native_reads() {
    let filter = WindowFilter {
        app: None,
        focused_only: false,
    };

    let error = list_windows_until(&filter, Instant::now()).unwrap_err();

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

#[test]
fn explicit_app_filter_distinguishes_not_running_from_no_windows() {
    let empty = rustc_hash::FxHashSet::default();
    let error = require_running_app(&empty, "WhatsApp").unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::AppNotFound);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );

    let running = rustc_hash::FxHashSet::from_iter([42]);
    assert!(require_running_app(&running, "WhatsApp").is_ok());
}

#[test]
fn scoped_validation_ignores_unrelated_owner_churn() {
    let before = ScopedOwners(FxHashMap::from_iter([(10, 100.0), (20, 200.0)]));
    let after = ScopedOwners(FxHashMap::from_iter([(10, 100.0), (30, 300.0)]));
    let selected = rustc_hash::FxHashSet::from_iter([10]);

    crate::system::window::window_inventory_global::validate_scoped_snapshot_pair(
        &before,
        &after,
        &selected,
        &selected,
        &[],
    )
    .unwrap();
}

#[test]
fn scoped_validation_rejects_selected_owner_replacement() {
    let before = ScopedOwners(FxHashMap::from_iter([(10, 100.0)]));
    let after = ScopedOwners(FxHashMap::from_iter([(10, 101.0)]));
    let selected = rustc_hash::FxHashSet::from_iter([10]);

    let error = crate::system::window::window_inventory_global::validate_scoped_snapshot_pair(
        &before,
        &after,
        &selected,
        &selected,
        &[],
    )
    .unwrap_err();

    assert_eq!(
        error.details.unwrap()["phase"],
        "selected_appkit_snapshot_changed"
    );
}

#[test]
fn scoped_validation_rejects_selected_pid_membership_change() {
    let before = ScopedOwners(FxHashMap::from_iter([(10, 100.0)]));
    let after = ScopedOwners(FxHashMap::from_iter([(11, 101.0)]));
    let before_pids = rustc_hash::FxHashSet::from_iter([10]);
    let after_pids = rustc_hash::FxHashSet::from_iter([11]);

    let error = crate::system::window::window_inventory_global::validate_scoped_snapshot_pair(
        &before,
        &after,
        &before_pids,
        &after_pids,
        &[],
    )
    .unwrap_err();

    assert_eq!(
        error.details.unwrap()["phase"],
        "selected_appkit_snapshot_changed"
    );
}

fn record(app_name: &str, pid: i32, title: &str, window_number: i64) -> WindowRecord {
    WindowRecord {
        app_name: app_name.to_string(),
        pid,
        title: Some(title.to_string()),
        window_number,
        bounds: agent_desktop_core::Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        visible: true,
        process_instance: Some(format!("instance-{pid}")),
    }
}

fn window_with_state(id: &str, visible: Option<bool>, minimized: Option<bool>) -> WindowInfo {
    WindowInfo {
        id: id.to_owned(),
        title: "w".into(),
        app: "Fixture".into(),
        pid: agent_desktop_core::ProcessId::new(42),
        process_instance: Some("fixture-42".into()),
        bounds: None,
        state: agent_desktop_core::WindowState {
            is_focused: false,
            accessible: true,
            minimized,
            visible,
        },
    }
}

#[test]
fn narrowing_drops_unconfirmed_panels_but_keeps_ax_windows() {
    let mut windows = vec![
        window_with_state("ax-offscreen", Some(false), Some(false)),
        window_with_state("cg-only-panel", Some(false), None),
        window_with_state("minimized", Some(false), Some(true)),
        window_with_state("onscreen", Some(true), Some(false)),
    ];

    narrow_to_real_windows(&mut windows);

    let kept = windows.iter().map(|w| w.id.as_str()).collect::<Vec<_>>();
    assert_eq!(kept, vec!["ax-offscreen", "minimized", "onscreen"]);
}

#[test]
fn narrowing_leaves_nothing_when_an_application_has_only_panels() {
    let mut windows = vec![window_with_state("panel", Some(false), None)];

    narrow_to_real_windows(&mut windows);

    assert!(windows.is_empty());
}
