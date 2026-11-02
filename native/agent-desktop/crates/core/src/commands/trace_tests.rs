use super::*;
use crate::refs::refs_test_support::HomeGuard;
use crate::session::{SessionTraceMode, StartSessionOptions, start_session};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[path = "trace_observer_tests.rs"]
mod observer_tests;

fn fixture_trace_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/trace_show/trace")
}

fn copy_fixture_trace(dest: &Path) {
    fs::create_dir_all(dest).unwrap();
    for name in ["100-1000.jsonl", "200-2000.jsonl"] {
        fs::copy(fixture_trace_dir().join(name), dest.join(name)).unwrap();
    }
}

#[test]
fn show_merges_fixture_segments_with_expected_shape() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    copy_fixture_trace(&trace_dir);

    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let body = execute(
        TraceAction::Show {
            limit: 0,
            event: None,
        },
        &context,
    )
    .unwrap();

    assert_eq!(body["session_id"], manifest.id);
    assert_eq!(body["segments"].as_array().unwrap().len(), 2);
    assert_eq!(body["total_events"].as_u64().unwrap(), 5);
    assert_eq!(body["returned_events"], 5);
    assert_eq!(body["truncated"], false);
    assert_eq!(body["events"][0]["event"], "trace.meta");
    assert_eq!(body["events"][1]["snapshot_id"], "snap-a");
    assert_eq!(body["events"][2]["snapshot_id"], "snap-b");
    assert!(
        body.get("matched_events").is_none(),
        "matched_events must be omitted when --event is not passed"
    );
}

#[test]
fn show_without_active_session_is_invalid_args() {
    let _guard = HomeGuard::new();
    let context = CommandContext::new(None, None, false).unwrap();
    let err = execute(
        TraceAction::Show {
            limit: 500,
            event: None,
        },
        &context,
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn show_without_trace_directory_is_invalid_args() {
    let _guard = HomeGuard::new();
    let context = CommandContext::new(Some("legacy-no-trace".into()), None, false).unwrap();
    let err = execute(
        TraceAction::Show {
            limit: 500,
            event: None,
        },
        &context,
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn show_reports_raw_total_and_matched_count_when_filtered() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    copy_fixture_trace(&trace_dir);

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let body = execute(
        TraceAction::Show {
            limit: 0,
            event: Some("command.".into()),
        },
        &context,
    )
    .unwrap();

    assert_eq!(body["total_events"].as_u64().unwrap(), 5);
    assert_eq!(body["matched_events"].as_u64().unwrap(), 2);
    assert_eq!(body["returned_events"], 2);
}

#[test]
fn show_matched_events_survives_limit_truncation_from_single_read() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    copy_fixture_trace(&trace_dir);

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let body = execute(
        TraceAction::Show {
            limit: 1,
            event: Some("command.".into()),
        },
        &context,
    )
    .unwrap();

    assert_eq!(body["total_events"].as_u64().unwrap(), 5);
    assert_eq!(body["matched_events"].as_u64().unwrap(), 2);
    assert_eq!(body["returned_events"], 1);
    assert_eq!(body["truncated"], true);
}

#[test]
fn show_on_empty_trace_directory_is_invalid_args() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let err = execute(
        TraceAction::Show {
            limit: 500,
            event: None,
        },
        &context,
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.to_string().contains("empty trace directory"));
}

#[test]
fn export_on_empty_trace_directory_is_invalid_args() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let err = execute(
        TraceAction::Export {
            limit: 0,
            out: None,
        },
        &context,
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(err.to_string().contains("empty trace directory"));
}

#[test]
fn tail_limit_surfaces_unpaired_command_warning() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    fs::create_dir_all(&trace_dir).unwrap();
    let path = trace_dir.join("100-1000.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    writeln!(
        file,
        r#"{{"event":"command.start","command":"click","ts_ms":1,"seq":1}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"event":"command.end","command":"snapshot","ok":true,"duration_ms":1,"ts_ms":2,"seq":2}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"event":"command.start","command":"type","ts_ms":3,"seq":3}}"#
    )
    .unwrap();

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let body = execute(
        TraceAction::Show {
            limit: 2,
            event: None,
        },
        &context,
    )
    .unwrap();
    assert_eq!(body["truncated"], true);
    let warnings = body["warnings"].as_array().expect("warnings");
    assert!(
        warnings
            .iter()
            .any(|warning| warning["kind"] == "unpaired_command")
    );
}

#[test]
fn export_json_surfaces_warnings_and_truncation_without_html() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    fs::create_dir_all(&trace_dir).unwrap();
    fs::write(trace_dir.join("notes.txt"), b"not a trace segment").unwrap();
    let path = trace_dir.join("100-1000.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    writeln!(
        file,
        r#"{{"event":"command.start","command":"click","ts_ms":1,"seq":1}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"event":"command.end","command":"click","ok":true,"duration_ms":1,"ts_ms":2,"seq":2}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"event":"command.start","command":"type","ts_ms":3,"seq":3}}"#
    )
    .unwrap();

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let body = execute(
        TraceAction::Export {
            limit: 2,
            out: None,
        },
        &context,
    )
    .unwrap();

    assert_eq!(body["total_events"].as_u64().unwrap(), 3);
    assert_eq!(body["returned_events"], 2);
    assert_eq!(body["event_count"], 2);
    assert_eq!(body["truncated"], true);
    assert!(body["path"].as_str().unwrap().ends_with(".html"));
    assert!(body["bytes"].as_u64().unwrap() > 0);
    let warnings = body["warnings"].as_array().expect("warnings");
    assert!(
        warnings
            .iter()
            .any(|warning| warning["kind"] == "foreign_file"),
        "expected a foreign_file warning, got {warnings:?}"
    );
}

#[test]
fn export_json_omits_warnings_when_trace_is_clean() {
    let _guard = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    fs::create_dir_all(&trace_dir).unwrap();
    let path = trace_dir.join("100-1000.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    writeln!(
        file,
        r#"{{"event":"snapshot.saved","snapshot_id":"s1","ts_ms":1,"seq":1}}"#
    )
    .unwrap();

    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let body = execute(
        TraceAction::Export {
            limit: 0,
            out: None,
        },
        &context,
    )
    .unwrap();

    assert_eq!(body["total_events"].as_u64().unwrap(), 1);
    assert_eq!(body["returned_events"], 1);
    assert_eq!(body["event_count"], 1);
    assert_eq!(body["truncated"], false);
    assert!(body.get("warnings").is_none());
}
