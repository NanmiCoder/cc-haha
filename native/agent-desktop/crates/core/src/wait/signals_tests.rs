use super::*;

fn window(id: &str, title: &str, app: &str, pid: u32, focused: bool) -> WindowInfo {
    WindowInfo {
        id: id.into(),
        title: title.into(),
        app: app.into(),
        pid: crate::ProcessId::new(pid),
        process_instance: Some(format!("instance-{pid}")),
        bounds: None,
        state: crate::WindowState {
            is_focused: focused,
            ..Default::default()
        },
    }
}

fn app(name: &str, pid: u32) -> AppInfo {
    app_with_instance(name, pid, &format!("instance-{pid}"))
}

fn app_with_instance(name: &str, pid: u32, instance: &str) -> AppInfo {
    AppInfo {
        name: name.into(),
        pid: crate::ProcessId::new(pid),
        bundle_id: None,
        process_instance: Some(instance.into()),
        presentation: None,
    }
}

fn baseline_with_windows(windows: Vec<WindowInfo>) -> SignalBaseline {
    SignalBaseline {
        windows,
        apps: Vec::new(),
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    }
}

#[test]
fn new_window_id_produces_window_opened() {
    let baseline = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, true)]);
    let current = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::WindowOpened);
    assert_eq!(events[0].window_id.as_deref(), Some("w-2"));
    assert_eq!(events[0].title.as_deref(), Some("Untitled"));
}

#[test]
fn removed_window_id_produces_window_closed() {
    let baseline = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);
    let current = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, true)]);

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::WindowClosed);
    assert_eq!(events[0].window_id.as_deref(), Some("w-2"));
}

#[test]
fn window_closed_fires_even_as_another_window_opens() {
    let baseline = baseline_with_windows(vec![
        window("w-1", "Untitled", "TextEdit", 200, true),
        window("w-9", "Finder", "Finder", 100, false),
    ]);
    let current = baseline_with_windows(vec![
        window("w-9", "Finder", "Finder", 100, false),
        window("w-42", "Preview", "Preview", 300, true),
    ]);

    let events = diff_signals(&baseline, &current);

    let closed: Vec<_> = events
        .iter()
        .filter(|e| e.kind == EventKind::WindowClosed)
        .collect();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0].window_id.as_deref(), Some("w-1"));

    let opened: Vec<_> = events
        .iter()
        .filter(|e| e.kind == EventKind::WindowOpened)
        .collect();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].window_id.as_deref(), Some("w-42"));
}

#[test]
fn focus_change_produces_focus_changed_window_event() {
    let baseline = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);
    let current = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, false),
        window("w-2", "Untitled", "TextEdit", 200, true),
    ]);

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::FocusChangedWindow);
    assert_eq!(events[0].window_id.as_deref(), Some("w-2"));
}

#[test]
fn focus_change_between_two_same_title_windows_reports_correct_id() {
    let baseline = baseline_with_windows(vec![
        window("w-1", "Untitled", "TextEdit", 200, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);
    let current = baseline_with_windows(vec![
        window("w-1", "Untitled", "TextEdit", 200, false),
        window("w-2", "Untitled", "TextEdit", 200, true),
    ]);

    let events = diff_signals(&baseline, &current);

    let focus_events: Vec<_> = events
        .iter()
        .filter(|e| e.kind == EventKind::FocusChangedWindow)
        .collect();
    assert_eq!(focus_events.len(), 1);
    assert_eq!(
        focus_events[0].window_id.as_deref(),
        Some("w-2"),
        "focus event must key off id, not the shared title"
    );
}

#[test]
fn app_launch_and_terminate_are_detected_by_pid() {
    let baseline = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app("Finder", 1)],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app("Finder", 1), app("TextEdit", 2)],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::AppLaunched);
    assert_eq!(events[0].pid, Some(crate::ProcessId::new(2)));

    let events_back = diff_signals(&current, &baseline);
    assert_eq!(events_back.len(), 1);
    assert_eq!(events_back[0].kind, EventKind::AppTerminated);
    assert_eq!(events_back[0].pid, Some(crate::ProcessId::new(2)));
}

#[test]
fn sheet_appears_under_app_filter_produces_surface_appeared() {
    let baseline = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: vec![SurfaceSignal {
            kind: SnapshotSurface::Sheet,
            app: "TextEdit".into(),
            pid: crate::ProcessId::new(200),
            process_instance: "instance-200".into(),
            id: "sheet-1".into(),
            title: None,
        }],
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    match &events[0].kind {
        EventKind::SurfaceAppeared { surface } => assert_eq!(*surface, SnapshotSurface::Sheet),
        other => panic!("expected SurfaceAppeared, got {other:?}"),
    }
    assert_eq!(events[0].app.as_deref(), Some("TextEdit"));
    assert_eq!(events[0].pid, Some(crate::ProcessId::new(200)));
}

#[test]
fn surface_dismissed_fires_when_sheet_count_drops() {
    let baseline = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: vec![SurfaceSignal {
            kind: SnapshotSurface::Sheet,
            app: "TextEdit".into(),
            pid: crate::ProcessId::new(200),
            process_instance: "instance-200".into(),
            id: "sheet-1".into(),
            title: None,
        }],
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: Vec::new(),
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    assert!(matches!(events[0].kind, EventKind::SurfaceDismissed { .. }));
}

#[test]
fn reorder_only_baselines_produce_zero_events() {
    let baseline = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);
    let current = baseline_with_windows(vec![
        window("w-2", "Untitled", "TextEdit", 200, false),
        window("w-1", "Docs", "Finder", 100, true),
    ]);

    let events = diff_signals(&baseline, &current);

    assert!(
        events.is_empty(),
        "reordering the same windows must not synthesize open/close/focus events, got {events:?}"
    );
}

#[test]
fn equal_window_ids_from_different_processes_are_distinct() {
    let baseline = baseline_with_windows(vec![window("42", "Old", "Alpha", 100, false)]);
    let current = baseline_with_windows(vec![window("42", "New", "Beta", 200, false)]);

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, EventKind::WindowClosed);
    assert_eq!(events[0].pid, Some(crate::ProcessId::new(100)));
    assert_eq!(events[1].kind, EventKind::WindowOpened);
    assert_eq!(events[1].pid, Some(crate::ProcessId::new(200)));
}

#[test]
fn recycled_pid_with_changed_app_identity_emits_both_lifecycle_events() {
    let baseline = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app_with_instance("Alpha", 100, "generation-a")],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app_with_instance("Beta", 100, "generation-b")],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, EventKind::AppTerminated);
    assert_eq!(events[0].app.as_deref(), Some("Alpha"));
    assert_eq!(events[1].kind, EventKind::AppLaunched);
    assert_eq!(events[1].app.as_deref(), Some("Beta"));
}

#[test]
fn app_metadata_change_does_not_synthesize_lifecycle_events() {
    let baseline = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app_with_instance("Old Name", 100, "same-generation")],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app_with_instance("New Name", 100, "same-generation")],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };

    assert!(diff_signals(&baseline, &current).is_empty());
}

#[test]
fn focus_cleared_produces_an_identity_free_focus_event() {
    let baseline = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, true)]);
    let current = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, false)]);

    let events = diff_signals(&baseline, &current);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::FocusChangedWindow);
    assert_eq!(events[0].window_id, None);
    assert_eq!(events[0].app, None);
    assert_eq!(events[0].pid, None);
}

#[test]
fn reused_pid_and_window_id_with_new_process_generation_is_replacement() {
    let mut old = window("w-1", "Old", "Editor", 100, false);
    old.process_instance = Some("generation-a".into());
    let mut new = window("w-1", "New", "Editor", 100, false);
    new.process_instance = Some("generation-b".into());

    let events = diff_signals(
        &baseline_with_windows(vec![old]),
        &baseline_with_windows(vec![new]),
    );

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].kind, EventKind::WindowClosed);
    assert_eq!(events[1].kind, EventKind::WindowOpened);
}

#[path = "signals_surface_tests.rs"]
mod surface_tests;

#[path = "signals_merge_tests.rs"]
mod merge_tests;
