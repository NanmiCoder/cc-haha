use super::*;

#[test]
fn merge_signal_baseline_adds_a_new_window_not_already_seen() {
    let seen = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, true)]);
    let current = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);

    let merged = merge_signal_baseline(&seen, &current);

    assert_eq!(merged.windows.len(), 2);
}

#[test]
fn merge_signal_baseline_retains_an_entry_missing_from_current() {
    let seen = baseline_with_windows(vec![
        window("w-1", "Docs", "Finder", 100, true),
        window("w-2", "Untitled", "TextEdit", 200, false),
    ]);
    let current = baseline_with_windows(vec![window("w-1", "Docs", "Finder", 100, true)]);

    let merged = merge_signal_baseline(&seen, &current);

    assert_eq!(
        merged.windows.len(),
        2,
        "the running union must not drop an entry that disappeared this poll"
    );
}

#[test]
fn merge_signal_baseline_does_not_duplicate_an_already_seen_app() {
    let seen = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app("Finder", 1)],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };
    let current = SignalBaseline {
        windows: Vec::new(),
        apps: vec![app("Finder", 1)],
        surfaces: Vec::new(),
        completeness: crate::SignalCompleteness::complete(),
    };

    let merged = merge_signal_baseline(&seen, &current);

    assert_eq!(merged.apps.len(), 1);
}

#[test]
fn merge_signal_baseline_round_trip_detects_appear_then_disappear() {
    let seen = baseline_with_windows(Vec::new());
    let appeared = baseline_with_windows(vec![window("w-9", "Untitled", "TextEdit", 200, false)]);
    let seen = merge_signal_baseline(&seen, &appeared);
    let disappeared = baseline_with_windows(Vec::new());

    let events = diff_signals(&seen, &disappeared);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, EventKind::WindowClosed);
    assert_eq!(events[0].window_id.as_deref(), Some("w-9"));
}
