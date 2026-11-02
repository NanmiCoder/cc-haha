use crate::refs::refs_test_support::HomeGuard;
use crate::session::{SessionTraceMode, StartSessionOptions, start_session};
use crate::trace::trace_read::{ExportOptions, export_html};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn write_segment(trace_dir: &Path, name: &str, lines: &[&str]) {
    fs::create_dir_all(trace_dir).unwrap();
    let mut file = fs::File::create(trace_dir.join(name)).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}

fn setup_trace_session() -> (
    HomeGuard,
    std::sync::MutexGuard<'static, ()>,
    String,
    PathBuf,
) {
    let lock = super::tests::html_test_guard();
    super::clear_test_max_json_bytes();
    let home = HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    (home, lock, manifest.id, trace_dir)
}

#[test]
fn export_stats_reports_warnings_and_truncation() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[
            r#"{"event":"a","ts_ms":1,"seq":1}"#,
            r#"{"event":"b","ts_ms":2,"seq":2}"#,
            r#"{"event":"c","ts_ms":3,"seq":3}"#,
        ],
    );
    fs::write(trace_dir.join("notes.txt"), b"not a segment").unwrap();
    let (_html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 2,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.total_events, 3);
    assert_eq!(stats.returned_events, 2);
    assert!(stats.truncated);
    assert!(
        stats.warnings.iter().any(|w| w["kind"] == "foreign_file"),
        "expected foreign_file warning, got {:?}",
        stats.warnings
    );
}
