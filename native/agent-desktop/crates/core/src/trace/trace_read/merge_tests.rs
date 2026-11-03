use super::merge::{
    MergeItem, annotate_provenance, apply_tail_limit, detect_unpaired_commands,
    filter_by_event_prefix, merge_segments,
};
use super::segment::ParsedEvent;
use serde_json::{Value, json};

fn event(ts: u64, position: u64, name: &str) -> ParsedEvent {
    ParsedEvent {
        value: json!({"event": name, "ts_ms": ts, "seq": position}),
        ts_ms: ts,
        position,
    }
}

#[test]
fn two_segments_interleave_by_ts_ms() {
    let a = vec![event(100, 1, "a"), event(300, 2, "a")];
    let b = vec![event(200, 1, "b")];
    let merged = merge_segments(vec![(a, 10, "10-1".into()), (b, 20, "20-1".into())]);
    let names: Vec<_> = merged
        .iter()
        .map(|m| m.event.value["event"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["a", "b", "a"]);
}

#[test]
fn same_millisecond_tie_orders_by_pid_then_position() {
    let a = vec![event(500, 1, "a")];
    let b = vec![event(500, 1, "b")];
    let merged = merge_segments(vec![(a, 10, "10-1".into()), (b, 20, "20-1".into())]);
    assert_eq!(merged[0].writer_pid, 10);
    assert_eq!(merged[1].writer_pid, 20);
}

#[test]
fn in_process_ts_regression_preserves_seq_order() {
    let a = vec![event(1000, 5, "a5"), event(999, 6, "a6")];
    let b = vec![event(999, 1, "b1")];
    let merged = merge_segments(vec![(a, 10, "10-1".into()), (b, 20, "20-1".into())]);
    let positions: Vec<_> = merged
        .iter()
        .map(|m| (m.writer_pid, m.event.position))
        .collect();
    assert_eq!(positions, vec![(20, 1), (10, 5), (10, 6)]);
}

#[test]
fn discovery_order_independence_via_merge() {
    let a = vec![event(500, 1, "a")];
    let b = vec![event(500, 1, "b")];
    let forward = merge_segments(vec![
        (a.clone(), 10, "10-1".into()),
        (b.clone(), 20, "20-1".into()),
    ]);
    let reverse = merge_segments(vec![(b, 20, "20-1".into()), (a, 10, "10-1".into())]);
    let names_fwd: Vec<_> = forward
        .iter()
        .map(|m| m.event.value["event"].as_str())
        .collect();
    let names_rev: Vec<_> = reverse
        .iter()
        .map(|m| m.event.value["event"].as_str())
        .collect();
    assert_eq!(names_fwd, vec![Some("a"), Some("b")]);
    assert_eq!(names_rev, names_fwd);
}

#[test]
fn provenance_does_not_clobber_existing_pid() {
    let item = MergeItem {
        event: ParsedEvent {
            value: json!({"event":"ref.resolve.entry","pid":9999,"ts_ms":1,"seq":1}),
            ts_ms: 1,
            position: 1,
        },
        writer_pid: 100,
        segment: "100-1".into(),
    };
    let annotated = annotate_provenance(&item);
    assert_eq!(annotated["pid"], 9999);
    assert_eq!(annotated["writer_pid"], 100);
    assert_eq!(annotated["segment"], "100-1");
}

#[test]
fn unknown_fields_pass_through() {
    let item = MergeItem {
        event: ParsedEvent {
            value: json!({"event":"future.event","ts_ms":1,"seq":1,"new_field":"value"}),
            ts_ms: 1,
            position: 1,
        },
        writer_pid: 1,
        segment: "1-1".into(),
    };
    let annotated = annotate_provenance(&item);
    assert_eq!(annotated["new_field"], "value");
}

#[test]
fn event_prefix_filter_with_tail_limit() {
    let events: Vec<Value> = (0..10)
        .map(|i| json!({"event": if i % 2 == 0 { "action.click" } else { "other" }, "ts_ms": i}))
        .collect();
    let filtered = filter_by_event_prefix(events, Some("action."));
    assert_eq!(filtered.len(), 5);
    let (tail, truncated) = apply_tail_limit(filtered, 2);
    assert!(truncated);
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0]["ts_ms"], 6);
    assert_eq!(tail[1]["ts_ms"], 8);
}

#[test]
fn unpaired_command_start_is_detected() {
    let events = vec![
        json!({"event":"command.start","command":"click","segment":"100-1","writer_pid":100,"ts_ms":1}),
        json!({"event":"command.end","command":"click","segment":"100-1","writer_pid":100,"ts_ms":2}),
        json!({"event":"command.start","command":"type","segment":"100-1","writer_pid":100,"ts_ms":3}),
    ];
    let warnings = detect_unpaired_commands(&events, None);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains("type"));
}

#[test]
fn limit_zero_returns_all() {
    let events: Vec<Value> = (0..5).map(|i| json!({"event":"e","ts_ms":i})).collect();
    let (all, truncated) = apply_tail_limit(events.clone(), 0);
    assert!(!truncated);
    assert_eq!(all.len(), 5);
}
