use crate::refs::refs_test_support::HomeGuard;
use crate::session::{SessionTraceMode, StartSessionOptions, start_session};
use crate::trace::trace_read::{ExportOptions, export_html};
use serde_json::Value;
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

fn parse_trace_data_island(html: &str) -> Value {
    let marker = "<script id=\"trace-data\" type=\"application/json\">";
    let start = html.find(marker).unwrap() + marker.len();
    let end = start + html[start..].find("</script>").unwrap();
    serde_json::from_str(&html[start..end]).unwrap()
}

#[test]
fn traversal_screenshot_path_is_not_embedded() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    let marker = "SENTINEL-TRAVERSAL-4f2c9a";
    let sentinel = trace_dir.parent().unwrap().join("secret.png");
    fs::write(&sentinel, marker).unwrap();
    assert_eq!(fs::read_to_string(&sentinel).unwrap(), marker);

    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"action.artifacts","screenshot_pre":"../secret.png","ts_ms":1,"seq":1}"#],
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
    assert_eq!(stats.screenshots_skipped, 1);
    assert_eq!(stats.screenshots_embedded, 0);
    let island = parse_trace_data_island(&html);
    assert!(island["screenshots"].as_object().unwrap().is_empty());
    assert!(!html.contains(marker));
}

#[test]
fn absolute_screenshot_path_is_not_embedded() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    let marker = "SENTINEL-ABSOLUTE-8b1d3e";
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let sentinel = std::env::temp_dir().join(format!("agent-desktop-abs-secret-{nanos}.png"));
    fs::write(&sentinel, marker).unwrap();
    assert_eq!(fs::read_to_string(&sentinel).unwrap(), marker);

    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[&serde_json::json!({
            "event": "action.artifacts",
            "screenshot_pre": sentinel.to_string_lossy(),
            "ts_ms": 1,
            "seq": 1,
        })
        .to_string()],
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
    assert_eq!(stats.screenshots_skipped, 1);
    assert_eq!(stats.screenshots_embedded, 0);
    let island = parse_trace_data_island(&html);
    assert!(island["screenshots"].as_object().unwrap().is_empty());
    assert!(!html.contains(marker));
    let _ = fs::remove_file(&sentinel);
}

#[cfg(unix)]
#[test]
fn symlinked_screenshot_path_is_not_embedded() {
    let (_home, _lock, session_id, trace_dir) = setup_trace_session();
    let marker = "SENTINEL-SYMLINK-71ea9c";
    let target = trace_dir.parent().unwrap().join("symlink-target.png");
    fs::write(&target, marker).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), marker);
    fs::create_dir_all(trace_dir.join("screens")).unwrap();
    std::os::unix::fs::symlink(&target, trace_dir.join("screens/link.png")).unwrap();

    write_segment(
        &trace_dir,
        "100-1000.jsonl",
        &[r#"{"event":"action.artifacts","screenshot_pre":"screens/link.png","ts_ms":1,"seq":1}"#],
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
    assert_eq!(stats.screenshots_skipped, 1);
    assert_eq!(stats.screenshots_embedded, 0);
    let island = parse_trace_data_island(&html);
    assert!(island["screenshots"].as_object().unwrap().is_empty());
    assert!(!html.contains(marker));
}
