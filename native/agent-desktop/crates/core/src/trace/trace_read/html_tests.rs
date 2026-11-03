use super::escape_for_json_island;
use crate::refs::refs_test_support::HomeGuard;
use crate::session::{SessionTraceMode, StartSessionOptions, start_session};
use crate::trace::trace_read::{ExportOptions, export_html};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static HTML_TEST_LOCK: Mutex<()> = Mutex::new(());

pub(super) fn html_test_guard() -> std::sync::MutexGuard<'static, ()> {
    HTML_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_segment(trace_dir: &Path, name: &str, lines: &[&str]) {
    fs::create_dir_all(trace_dir).unwrap();
    let mut file = fs::File::create(trace_dir.join(name)).unwrap();
    for line in lines {
        writeln!(file, "{line}").unwrap();
    }
}

fn setup_html_test() -> (HomeGuard, std::sync::MutexGuard<'static, ()>) {
    let lock = html_test_guard();
    super::clear_test_max_json_bytes();
    (HomeGuard::new(), lock)
}

fn setup_trace_session() -> (
    HomeGuard,
    std::sync::MutexGuard<'static, ()>,
    String,
    PathBuf,
) {
    let (home, lock) = setup_html_test();
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

fn parse_trace_data_island(html: &str) -> Value {
    let marker = "<script id=\"trace-data\" type=\"application/json\">";
    let start = html.find(marker).unwrap() + marker.len();
    let end = start + html[start..].find("</script>").unwrap();
    serde_json::from_str(&html[start..end]).unwrap()
}

#[test]
fn export_writes_single_self_contained_file() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"command.start","command":"snapshot","ts_ms":1,"seq":1}"#],
    );
    let out = std::env::temp_dir().join(format!(
        "trace-export-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let (_html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: Some(out.clone()),
        },
    )
    .unwrap();
    assert_eq!(stats.event_count, 1);
    assert!(stats.bytes > 0);
    let body = fs::read_to_string(&out).unwrap();
    assert!(!body.contains("src=\"http"));
    assert!(!body.contains("<link href"));
    let _ = fs::remove_file(out);
}

#[test]
fn hostile_strings_are_escaped_in_json_island() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    let hostile = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[&format!(
            r#"{{"event":"command.end","command":"snapshot","ok":false,"message":"{hostile}","ts_ms":1,"seq":1}}"#
        )],
    );
    let (html, _) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert!(!html.contains("<script>alert"));
    assert!(!html.contains("<img src=x onerror"));
    assert!(html.contains(
        "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\\u003cimg src=x onerror=alert(2)\\u003e"
    ));
}

#[test]
fn json_island_round_trips() {
    let raw = r#"{"event":"test","value":"<tag>&"}"#;
    let escaped = escape_for_json_island(raw);
    let start = escaped.find('{').unwrap();
    let end = escaped.rfind('}').unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&escaped[start..=end]).unwrap();
    assert_eq!(parsed["value"], "<tag>&");
}

#[test]
fn missing_screenshot_counts_as_skipped_not_error() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[
            r#"{"event":"action.artifacts","screenshot_pre":"screens/missing.png","ts_ms":1,"seq":1}"#,
        ],
    );
    let (_html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.screenshots_skipped, 1);
}

#[test]
fn export_is_byte_deterministic() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"snapshot.saved","snapshot_id":"s1","ts_ms":1,"seq":1}"#],
    );
    let options = ExportOptions {
        limit: 0,
        out: None,
    };
    let (a, _) = export_html(&trace_dir, &session_id, &options).unwrap();
    let (b, _) = export_html(&trace_dir, &session_id, &options).unwrap();
    assert_eq!(a, b);
}

#[test]
fn default_output_path_uses_session_id() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"command.start","command":"x","ts_ms":1,"seq":1}"#],
    );
    let (_html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert!(stats.path.ends_with(&format!("trace-{session_id}.html")));
    assert!(
        std::path::Path::new(&stats.path).starts_with(trace_dir.parent().unwrap()),
        "default export must land inside the session directory, not the cwd"
    );
    let _ = fs::remove_file(&stats.path);
}

#[test]
fn oversized_json_guard_returns_invalid_args() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    crate::trace::trace_read::html::set_test_max_json_bytes(100);
    let huge = "x".repeat(200);
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[&format!(
            r#"{{"event":"note","payload":"{huge}","ts_ms":1,"seq":1}}"#
        )],
    );
    let err = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
    super::clear_test_max_json_bytes();
}

#[test]
fn embed_budget_skips_later_screenshots() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    fs::create_dir_all(trace_dir.join("screens")).unwrap();
    let big = vec![0u8; 60 * 1024 * 1024];
    write_screenshot_fixture(&trace_dir.join("screens/a.png"), &big);
    write_screenshot_fixture(&trace_dir.join("screens/b.png"), &big);
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[
            r#"{"event":"action.artifacts","screenshot_pre":"screens/a.png","ts_ms":1,"seq":1}"#,
            r#"{"event":"action.artifacts","screenshot_pre":"screens/b.png","ts_ms":2,"seq":2}"#,
        ],
    );
    let (_html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.screenshots_embedded, 1);
    assert_eq!(stats.screenshots_skipped, 1);
}

#[test]
fn export_honors_limit_in_metadata() {
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
    let (html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 2,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.event_count, 2);
    assert!(html.contains("\"truncated\":true"));
}

#[test]
fn redacted_field_survives_in_island_json() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"secret","title":{"redacted":true},"ts_ms":1,"seq":1}"#],
    );
    let (html, _) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert!(html.contains("\"redacted\":true"));
}

#[test]
fn empty_timeline_renders_empty_state_marker() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    fs::write(trace_dir.join("100-1000.jsonl"), "").unwrap();
    let (html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.event_count, 0);
    let island = parse_trace_data_island(&html);
    assert!(island["events"].as_array().unwrap().is_empty());
}

#[test]
fn unpaired_command_renders_open_incomplete_marker() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"command.start","command":"click","ts_ms":1,"seq":1}"#],
    );
    let (html, _) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    let island = parse_trace_data_island(&html);
    let warnings = island["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning["kind"] == "unpaired_command"),
        "expected an unpaired_command warning, got {warnings:?}"
    );
}

#[test]
fn embedded_screenshot_uses_base64_data_uri() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    fs::create_dir_all(trace_dir.join("screens")).unwrap();
    let png = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
    ];
    write_screenshot_fixture(&trace_dir.join("screens/shot.png"), &png);
    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"action.artifacts","screenshot_pre":"screens/shot.png","ts_ms":1,"seq":1}"#],
    );
    let (html, stats) = export_html(
        &trace_dir,
        &session_id,
        &ExportOptions {
            limit: 0,
            out: None,
        },
    )
    .unwrap();
    assert_eq!(stats.screenshots_embedded, 1);
    assert!(html.contains("data:image/png;base64,"));
}
fn write_screenshot_fixture(path: &std::path::Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
