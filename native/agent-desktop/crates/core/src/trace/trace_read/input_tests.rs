use super::{ReadOptions, read_merged};
use std::fs;
use std::io::Write;

fn directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("trace-input-{}", crate::refs::new_snapshot_id()));
    crate::storage::private_file_parent::ensure_private(&path).unwrap();
    path
}

#[test]
fn trace_input_budget_applies_before_the_output_tail_limit() {
    let dir = directory();
    let mut file = fs::File::create(dir.join("100-1.jsonl")).unwrap();
    for _ in 0..100_001 {
        writeln!(file, r#"{{"event":"a","ts_ms":1}}"#).unwrap();
    }
    drop(file);
    let result = read_merged(
        &dir,
        &ReadOptions {
            limit: 1,
            event_prefix: None,
        },
    );
    assert!(
        result.is_err(),
        "output limits must not allow unbounded input retention"
    );
}

#[test]
fn trace_byte_budget_is_shared_between_segments() {
    let dir = directory();
    for id in 1..=5 {
        let file = fs::File::create(dir.join(format!("{id}-1.jsonl"))).unwrap();
        file.set_len(8 * 1024 * 1024).unwrap();
    }
    let error = read_merged(&dir, &ReadOptions::default()).unwrap_err();
    assert!(error.to_string().contains("32 MiB"));
}

#[cfg(unix)]
#[test]
fn fifo_segment_is_rejected_instead_of_read_as_a_trace() {
    const CHILD: &str = "AGENT_DESKTOP_TRACE_FIFO_TEST";
    if std::env::var_os(CHILD).is_none() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "trace::trace_read::input_tests::fifo_segment_is_rejected_instead_of_read_as_a_trace",
            ])
            .env(CHILD, "1")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                let output = child.wait_with_output().unwrap();
                let stdout = String::from_utf8(output.stdout).unwrap();
                assert!(status.success(), "{stdout}");
                assert!(stdout.contains("test result: ok. 1 passed;"), "{stdout}");
                return;
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("trace reader blocked on FIFO");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let dir = directory();
    let path = dir.join("100-1.jsonl");
    let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let result = read_merged(&dir, &ReadOptions::default()).unwrap();
    assert!(result.segments.is_empty());
    assert!(
        result
            .warnings
            .iter()
            .any(|warning| warning.kind == super::TraceWarningKind::UnreadableSegment)
    );
}

#[test]
fn session_writer_preserves_readability_at_aggregate_byte_limit() {
    let dir = directory();
    let mut file = fs::File::create(dir.join("1-1.jsonl")).unwrap();
    let line = format!(
        "{{\"event\":\"padding\",\"ts_ms\":1,\"data\":\"{}\"}}\n",
        "a".repeat(65500)
    );
    let target = 32 * 1024 * 1024 - 128;
    let mut written = 0;
    while written + line.len() <= target {
        file.write_all(line.as_bytes()).unwrap();
        written += line.len();
    }
    file.write_all(&vec![b'\n'; target - written]).unwrap();
    drop(file);
    let writer = crate::trace::TraceConfig::build(None, Some(dir.clone()), true).unwrap();
    let error = writer
        .emit("last", None, serde_json::json!({}))
        .unwrap_err();
    assert!(error.to_string().contains("recording limit"), "{error}");
    let trace = read_merged(
        &dir,
        &ReadOptions {
            limit: 1,
            event_prefix: None,
        },
    )
    .unwrap();
    assert_eq!(trace.returned_events, 1);
}

#[test]
fn session_writer_preserves_readability_at_aggregate_event_limit() {
    let dir = directory();
    let mut file = std::io::BufWriter::new(fs::File::create(dir.join("1-1.jsonl")).unwrap());
    for _ in 0..100_000 {
        writeln!(file, r#"{{"event":"a","ts_ms":1}}"#).unwrap();
    }
    drop(file);
    let writer = crate::trace::TraceConfig::build(None, Some(dir.clone()), true).unwrap();
    let error = writer
        .emit("last", None, serde_json::json!({}))
        .unwrap_err();
    assert!(error.to_string().contains("recording limit"), "{error}");
    let trace = read_merged(
        &dir,
        &ReadOptions {
            limit: 1,
            event_prefix: None,
        },
    )
    .unwrap();
    assert_eq!(trace.total_events, 100_000);
}

#[test]
fn session_writer_stops_before_creating_an_excess_segment() {
    let dir = directory();
    for id in 1..=4094 {
        fs::File::create(dir.join(format!("{id}-1.jsonl"))).unwrap();
    }
    let writer = crate::trace::TraceConfig::build(None, Some(dir.clone()), true).unwrap();
    let error = writer
        .emit("last", None, serde_json::json!({}))
        .unwrap_err();
    assert!(
        error.to_string().contains("too many directory entries"),
        "{error}"
    );
    assert!(!crate::trace::trace_file::segment_path_for_dir(&dir).exists());
    assert!(read_merged(&dir, &ReadOptions::default()).is_ok());
}

#[test]
fn concurrent_session_writers_share_the_remaining_event_budget() {
    const CHILD: &str = "AGENT_DESKTOP_TRACE_BUDGET_CHILD";
    if let Some(dir) = std::env::var_os(CHILD) {
        let writer = crate::trace::TraceConfig::build(None, Some(dir.into()), true).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match writer.emit("child", None, serde_json::json!({})) {
                Ok(()) => return,
                Err(error) if error.code() == "TIMEOUT" && std::time::Instant::now() < deadline => {
                }
                Err(error) => {
                    assert!(error.to_string().contains("recording limit"), "{error}");
                    return;
                }
            }
        }
    }
    let dir = directory();
    let mut file = std::io::BufWriter::new(fs::File::create(dir.join("1-1.jsonl")).unwrap());
    for _ in 0..99_995 {
        writeln!(file, r#"{{"event":"a","ts_ms":1}}"#).unwrap();
    }
    drop(file);
    let writer = crate::trace::TraceConfig::build(None, Some(dir.clone()), true).unwrap();
    writer.emit("parent", None, serde_json::json!({})).unwrap();
    let mut children = Vec::new();
    for _ in 0..2 {
        children.push(std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "trace::trace_read::input_tests::concurrent_session_writers_share_the_remaining_event_budget"])
            .env(CHILD, &dir).stdout(std::process::Stdio::piped()).spawn().unwrap());
    }
    for child in children {
        let output = child.wait_with_output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{stdout}");
        assert!(stdout.contains("test result: ok. 1 passed;"), "{stdout}");
    }
    let trace = read_merged(&dir, &ReadOptions::default()).unwrap();
    assert_eq!(trace.total_events, 100_000);
    assert_eq!(
        trace
            .events
            .iter()
            .filter(|event| event["event"] == "child")
            .count(),
        1
    );
}

#[test]
fn interrupted_recording_ledger_stops_writes_without_losing_recorded_events() {
    let dir = directory();
    let writer = crate::trace::TraceConfig::build(None, Some(dir.clone()), true).unwrap();
    writer.emit("before", None, serde_json::json!({})).unwrap();
    fs::write(dir.join(".trace-usage.json"), b"[").unwrap();
    assert!(writer.emit("after", None, serde_json::json!({})).is_err());
    let trace = read_merged(&dir, &ReadOptions::default()).unwrap();
    assert_eq!(trace.total_events, 2);
    assert_eq!(trace.events.last().unwrap()["event"], "before");
}
