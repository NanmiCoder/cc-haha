use super::*;
use crate::AppError;
use crate::session::{SessionTraceMode, StartSessionOptions, start_session};
use serde_json::json;

#[test]
fn ended_session_refuses_command_scopes_before_dispatch() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let session = start_session(StartSessionOptions::default()).unwrap();
    let existing = CommandContext::new(Some(session.id.clone()), None, false).unwrap();
    existing.mutating_command_scope("click").unwrap();
    crate::session::end_session(&session.id).unwrap();
    let fresh = CommandContext::new(Some(session.id.clone()), None, false).unwrap();

    for context in [&existing, &fresh] {
        for result in [
            context.mutating_command_scope("click"),
            context.command_scope("snapshot"),
        ] {
            let error = match result {
                Ok(_) => panic!("an ended session must refuse dispatch"),
                Err(error) => error,
            };
            assert_eq!(error.code(), "INVALID_ARGS");
            let AppError::Adapter(error) = error else {
                panic!("a session refusal must carry delivery evidence")
            };
            assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
            assert_eq!(error.details.unwrap()["session_id"], session.id);
        }
    }
}

#[test]
fn command_scope_emits_start_and_success_end() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-ok-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let scope = context.command_scope("snapshot").unwrap();
    scope.complete(&Ok(json!({ "ok": true }))).unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains(r#""event":"command.start""#));
    assert!(body.contains(r#""event":"command.end""#));
    assert!(body.contains(r#""ok":true"#));
    let end_line = body
        .lines()
        .find(|line| line.contains(r#""event":"command.end""#))
        .expect("command.end line");
    let end_event: serde_json::Value = serde_json::from_str(end_line).unwrap();
    assert!(end_event["duration_ms"].as_u64().is_some());
    let _ = std::fs::remove_file(path);
}

#[test]
fn command_scope_emits_error_end_with_code_and_no_message() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-err-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let scope = context.command_scope("wait").unwrap();
    let err = AppError::invalid_input("bad args");
    scope.complete(&Err(err)).unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    assert!(body.contains(r#""ok":false"#));
    assert!(body.contains(r#""code":"INVALID_ARGS""#));
    assert!(!body.contains("bad args"));
    let _ = std::fs::remove_file(path);
}

#[test]
fn command_scope_drop_emits_internal_end_once() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-drop-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    {
        let _scope = context.command_scope("click").unwrap();
    }

    let body = std::fs::read_to_string(&path).unwrap();
    assert_eq!(body.matches(r#""event":"command.end""#).count(), 1);
    assert!(body.contains(r#""code":"INTERNAL""#));
    let _ = std::fs::remove_file(path);
}

#[test]
fn command_scope_is_noop_without_trace_sink() {
    let context = CommandContext::default();
    let scope = context.command_scope("status").unwrap();
    scope.complete(&Ok(json!({}))).unwrap();
}

#[test]
fn artifacts_full_follows_manifest_mode() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let manifest = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        artifacts: crate::session::ArtifactsMode::Full,
        ..Default::default()
    })
    .unwrap();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    assert!(context.artifacts_full());
}

#[test]
fn batch_item_with_failed_parent_trace_writes_to_its_own_session_segment() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let session = start_session(StartSessionOptions {
        trace: SessionTraceMode::On,
        ..Default::default()
    })
    .unwrap();
    let unopenable = std::env::temp_dir()
        .join("agent-desktop-batch-failed-parent-nodir")
        .join("trace.jsonl");
    let parent = CommandContext::new(None, Some(unopenable), false).unwrap();
    assert!(
        !parent.trace_enabled(),
        "parent explicit --trace to an unopenable path must have a failed (sinkless) writer"
    );

    let child = parent.for_batch_item(Some(session.id.clone())).unwrap();
    child
        .trace("batch.item.event", json!({ "ok": true }))
        .unwrap();

    let trace_dir = crate::refs::refs_store::RefStore::for_session(Some(&session.id))
        .unwrap()
        .trace_dir();
    let wrote = std::fs::read_dir(&trace_dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                std::fs::read_to_string(entry.path())
                    .map(|c| c.contains("batch.item.event"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    assert!(
        wrote,
        "a batch item targeting a trace-enabled session must write to that session's segment, not inherit the parent's dead --trace writer"
    );
}

#[test]
fn strict_command_start_failure_is_returned() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-start-failure-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(crate::trace::MAX_TRACE_FILE_BYTES)
        .unwrap();

    let error = match context.command_scope("snapshot") {
        Ok(_) => panic!("strict command start unexpectedly succeeded"),
        Err(error) => error,
    };

    assert_eq!(error.code(), "INVALID_ARGS");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn strict_read_only_command_end_failure_is_safe_to_retry() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-end-failure-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let scope = context.command_scope("snapshot").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(crate::trace::MAX_TRACE_FILE_BYTES)
        .unwrap();

    let error = scope.complete(&Ok(json!({}))).unwrap_err();

    assert_eq!(error.code(), "INVALID_ARGS");
    let AppError::Adapter(error) = error else {
        panic!("trace failure must be an adapter error");
    };
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn strict_mutating_command_end_failure_is_unsafe_to_retry() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-mutating-end-failure-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let scope = context.mutating_command_scope("click").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(crate::trace::MAX_TRACE_FILE_BYTES)
        .unwrap();

    let error = scope.complete(&Ok(json!({}))).unwrap_err();

    let AppError::Adapter(error) = error else {
        panic!("trace failure must be an adapter error");
    };
    assert_eq!(
        error.disposition,
        crate::DeliverySemantics::delivered_unverified()
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn command_end_omits_secret_and_huge_error_messages() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-scope-secret-error-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let scope = context.command_scope("click").unwrap();
    let secret = format!("secret-marker-{}", "x".repeat(2 * 1024 * 1024));

    scope
        .complete(&Err(AppError::invalid_input(secret.clone())))
        .unwrap();

    let body = std::fs::read_to_string(&path).unwrap();
    assert!(!body.contains("secret-marker"));
    assert!(body.len() < 4096);
    std::fs::remove_file(path).unwrap();
}
