use super::*;
use crate::session::{
    SessionTraceMode, StartSessionOptions, start_session, trace_enabled_for_session,
};
use serde_json::json;

#[test]
fn accepts_filesystem_safe_session_ids() {
    assert!(validate_session_id("agent-1_A").is_ok());
}

#[test]
fn session_cursor_config_is_loaded_by_commands_and_batch_entries() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let manifest = start_session(StartSessionOptions::default()).expect("session starts");
    let enabled =
        crate::CursorOverlayConfig::enabled(Some("Opening menu".into()), 6).expect("valid config");
    crate::session::set_cursor_overlay(&manifest.id, enabled).expect("setting persists");

    let context =
        CommandContext::new(Some(manifest.id.clone()), None, false).expect("context loads session");
    let batch_context = context
        .for_batch_item(None)
        .expect("batch inherits session");

    assert!(context.cursor_overlay().is_enabled());
    assert_eq!(context.cursor_overlay().label(), Some("Opening menu"));
    assert_eq!(batch_context.cursor_overlay(), context.cursor_overlay());
}

#[test]
fn rejects_path_like_session_ids() {
    assert!(validate_session_id("../agent").is_err());
    assert!(validate_session_id("agent/a").is_err());
}

#[test]
fn trace_writes_jsonl_without_stdout_dependency() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), false).unwrap();

    context
        .trace("ref.resolve.ok", json!({ "ref": "@e1" }))
        .unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    let event_line = body
        .lines()
        .find(|line| line.contains(r#""event":"ref.resolve.ok""#))
        .expect("event line");
    let event: serde_json::Value = serde_json::from_str(event_line).unwrap();
    assert_eq!(event["event"], "ref.resolve.ok");
    assert_eq!(event["ref"], "@e1");
    assert!(event["ts_ms"].as_u64().is_some());
    assert!(event.get("session_id").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn trace_injects_session_id_as_top_level_unredacted_field() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-session-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context =
        CommandContext::new(Some("my-session".into()), Some(path.clone()), false).unwrap();

    context
        .trace("ref.resolve.ok", json!({ "ref": "@e1" }))
        .unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    let event_line = body
        .lines()
        .find(|line| line.contains(r#""event":"ref.resolve.ok""#))
        .expect("event line");
    let event: serde_json::Value = serde_json::from_str(event_line).unwrap();
    assert_eq!(event["session_id"], "my-session");
    assert_eq!(event["event"], "ref.resolve.ok");
    assert!(event["ts_ms"].as_u64().is_some());
    assert!(!body.contains("redacted"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn trace_write_failure_is_best_effort_unless_strict() {
    let missing = std::env::temp_dir()
        .join("agent-desktop-missing-dir")
        .join("trace.jsonl");

    let best_effort = CommandContext::new(None, Some(missing.clone()), false).unwrap();
    assert!(best_effort.trace("event", json!({})).is_ok());
    assert!(CommandContext::new(None, Some(missing), false).is_ok());
}

#[test]
fn trace_lazy_does_not_build_fields_when_trace_is_disabled() {
    let context = CommandContext::default();
    let built = std::cell::Cell::new(false);

    context
        .trace_lazy("event", || {
            built.set(true);
            json!({})
        })
        .unwrap();

    assert!(!built.get());
}

#[cfg(unix)]
#[test]
fn trace_file_is_private_on_create() {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::temp_dir().join(format!(
        "agent-desktop-private-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    context.trace("event", json!({})).unwrap();

    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
#[test]
fn trace_rejects_loose_existing_file_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::temp_dir().join(format!(
        "agent-desktop-loose-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&path, "").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

    let err = CommandContext::new(None, Some(path.clone()), false).unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
    let _ = std::fs::remove_file(path);
}

#[test]
fn trace_redacts_sensitive_text_and_value_fields() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-redacted-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    context
        .trace(
            "event",
            json!({
                "text": "secret",
                "value": "hidden",
                "name": "private label",
                "description": "private desc",
                "message": "diagnostic error",
                "post_state": { "value": "deep secret" },
                "target_label": "button secret",
                "nested": { "expected": "token" },
                "title": "private window title",
                "url": "https://internal.example/doc",
                "help": "private tooltip",
                "placeholder": "private placeholder"
            }),
        )
        .unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    let event_line = body
        .lines()
        .find(|line| line.contains(r#""event":"event""#))
        .expect("event line");
    let event: serde_json::Value = serde_json::from_str(event_line).unwrap();
    assert_eq!(event["text"]["redacted"], true);
    assert_eq!(event["value"]["redacted"], true);
    assert_eq!(event["message"], "diagnostic error");
    assert!(!body.contains("secret"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn trace_strict_requires_trace_path_or_trace_session() {
    let err = CommandContext::new(None, None, true).unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn batch_item_clears_wait_selector() {
    let parent = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: "button:OK".into(),
        gone: false,
        timeout_ms: 5_000,
    }));
    let child = parent.for_batch_item(None).unwrap();
    assert!(child.wait_selector().is_none());
}

#[test]
fn batch_item_inherits_or_overrides_session_without_trace_loss() {
    let path = std::env::temp_dir().join("agent-desktop-context-test.jsonl");
    let _ = std::fs::remove_file(&path);
    let parent = CommandContext::new(Some("parent".into()), Some(path.clone()), false).unwrap();

    let inherited = parent.for_batch_item(None).unwrap();
    let overridden = parent.for_batch_item(Some("child".into())).unwrap();

    assert_eq!(inherited.session_id(), Some("parent"));
    assert_eq!(overridden.session_id(), Some("child"));
    overridden
        .trace("batch.child", json!({ "ok": true }))
        .unwrap();
    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains("batch.child"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn bare_session_without_manifest_does_not_trace() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let context = CommandContext::new(Some("legacy-session".into()), None, false).unwrap();
    assert!(!context.trace_enabled());
    context.trace("event", json!({})).unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some("legacy-session"))
        .unwrap()
        .trace_dir();
    assert!(!trace_dir.exists());
}

#[test]
fn trace_on_session_writes_segment_without_explicit_trace_flag() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    assert!(context.trace_enabled());
    context
        .trace("session.event", json!({ "ok": true }))
        .unwrap();
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let trace = crate::trace::trace_read::read_merged(&trace_dir, &Default::default()).unwrap();
    assert_eq!(trace.segments.len(), 1);
    assert!(
        trace
            .events
            .iter()
            .any(|event| event["event"] == "session.event")
    );
}

#[test]
fn no_trace_session_still_namespaces_snapshots() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::Off,
        ..Default::default()
    })
    .unwrap();
    assert!(!trace_enabled_for_session(&manifest.id).unwrap());
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    assert!(!context.trace_enabled());
    assert_eq!(context.session_id(), Some(manifest.id.as_str()));
}

#[test]
fn explicit_trace_overrides_session_sink() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-override-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context =
        CommandContext::new(Some(manifest.id.clone()), Some(path.clone()), false).unwrap();
    context.trace("override.event", json!({})).unwrap();
    assert!(path.exists());
    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    let segment_count = std::fs::read_dir(trace_dir)
        .map(|entries| entries.flatten().count())
        .unwrap_or(0);
    assert_eq!(segment_count, 0);
    let _ = std::fs::remove_file(path);
}

#[test]
fn batch_item_session_override_uses_its_own_segment_dir() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let parent_session = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let child_session = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let parent = CommandContext::new(Some(parent_session.id.clone()), None, false).unwrap();
    let child = parent
        .for_batch_item(Some(child_session.id.clone()))
        .unwrap();
    child.trace("child.event", json!({})).unwrap();
    let parent_trace = crate::refs::refs_store::RefStore::for_session(Some(&parent_session.id))
        .unwrap()
        .trace_dir();
    let parent_segments = std::fs::read_dir(&parent_trace)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
                .count()
        })
        .unwrap_or(0);
    assert_eq!(parent_segments, 0);
    let child_trace = crate::refs::refs_store::RefStore::for_session(Some(&child_session.id))
        .unwrap()
        .trace_dir();
    assert!(child_trace.is_dir());
}

#[test]
fn strict_parent_allows_no_trace_batch_override() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let traced = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let untraced = start_session(StartSessionOptions {
        name: None,
        trace: SessionTraceMode::Off,
        ..Default::default()
    })
    .unwrap();
    let parent = CommandContext::new(Some(traced.id.clone()), None, true).unwrap();
    let child = parent
        .for_batch_item(Some(untraced.id.clone()))
        .expect("a no-trace session override must not fail under a strict parent");
    assert_eq!(child.session_id(), Some(untraced.id.as_str()));
}
