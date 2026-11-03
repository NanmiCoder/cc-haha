use agent_desktop_core::ErrorCode;

use super::*;

fn kind(error: &AdapterError) -> &str {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
}

fn retryable(error: &AdapterError) -> Option<bool> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("retryable"))
        .and_then(serde_json::Value::as_bool)
}

#[test]
fn an_exited_application_and_a_destroyed_object_are_terminal() {
    let exited = settle_gone(AdapterError::new(ErrorCode::AppNotFound, "left"), u32::MAX);
    let destroyed = settle_gone(
        AdapterError::new(ErrorCode::ElementNotFound, "gone"),
        u32::MAX,
    );
    for error in [&exited, &destroyed] {
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
    }
    assert_eq!(kind(&exited), "resolve_owning_process_exited");
    assert_eq!(kind(&destroyed), "resolve_target_destroyed");
    assert_eq!(retryable(&exited), Some(false));
    assert!(!exited.is_explicitly_retryable());
    assert_eq!(retryable(&destroyed), Some(false));
    assert!(!destroyed.is_explicitly_retryable());
}

#[test]
fn an_error_that_is_not_a_departure_passes_through_unchanged() {
    let timeout = settle_gone(AdapterError::timeout("slow"), u32::MAX);
    assert_eq!(timeout.code, ErrorCode::Timeout);
}

#[test]
fn a_timeout_on_a_stopped_process_is_unresponsive_and_otherwise_a_timeout() {
    let stopped = stopped_aware(AdapterError::timeout("slow"), Some("files"));
    assert_eq!(stopped.code, ErrorCode::AppUnresponsive);
    assert!(stopped.message.contains("files"));

    let running = stopped_aware(AdapterError::timeout("slow"), None);
    assert_eq!(running.code, ErrorCode::Timeout);
}

#[test]
fn an_incomplete_observation_on_a_stopped_process_names_the_stopped_application() {
    let incomplete = || {
        AdapterError::new(ErrorCode::Timeout, "tree unreadable").with_details(
            serde_json::json!({ "kind": "resolution_identity_unknown", "retryable": true }),
        )
    };
    let stopped = stopped_aware(incomplete(), Some("files"));
    assert!(stopped.message.contains("files"));
    let answering = stopped_aware(incomplete(), None);
    assert_eq!(answering.code, ErrorCode::StaleRef);
    assert_eq!(answering.message, "tree unreadable");
    assert!(answering.is_explicitly_retryable());
}

#[test]
fn a_stopped_process_does_not_turn_a_settled_refusal_into_unresponsive() {
    let refused = stopped_aware(no_candidate(), Some("files"));
    assert_eq!(refused.code, ErrorCode::StaleRef);
}

#[test]
fn ambiguity_carries_the_candidate_count_and_is_settled() {
    let error = ambiguous(2);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(kind(&error), "resolve_ambiguous");
    assert_eq!(retryable(&error), Some(false));
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("candidate_count"))
            .and_then(serde_json::Value::as_u64),
        Some(2)
    );
}

#[test]
fn ambiguity_names_identical_tabs_as_the_usual_cause_and_what_to_change() {
    let text = ambiguous(3).suggestion.expect("a suggestion");
    assert!(text.contains("tabs or pages"), "{text}");
    assert!(text.contains("Close the extra pages"), "{text}");
}

#[test]
fn a_tied_window_tells_the_agent_what_to_change() {
    let error = window_tied();
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    let text = error.suggestion.expect("a suggestion");
    assert!(text.contains("Close one of them"), "{text}");
    assert!(text.contains("whose title differs"), "{text}");
}

#[test]
fn every_refusal_is_a_stale_ref_that_a_snapshot_repairs() {
    for (error, expected) in [
        (no_candidate(), true),
        (object_gone(), false),
        (window_replaced(), false),
        (window_unverifiable(), false),
        (unverifiable_entry(), false),
    ] {
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(retryable(&error), Some(expected), "{}", kind(&error));
        assert_eq!(error.is_explicitly_retryable(), expected);
        assert!(
            error
                .suggestion
                .as_deref()
                .is_some_and(|text| text.contains("snapshot"))
        );
    }
}

#[test]
fn the_running_test_process_is_not_stopped() {
    assert_eq!(stopped_app(std::process::id()), None);
}

#[cfg(target_os = "linux")]
#[test]
fn a_child_stopped_by_signal_is_named_by_its_listed_name() {
    use std::process::Command;
    use std::time::{Duration, Instant};

    let mut child = Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("sleep starts");
    let pid = child.id();
    let stopped = Command::new("kill")
        .args(["-STOP", &pid.to_string()])
        .status()
        .expect("kill runs")
        .success();
    let started = Instant::now();
    let mut named = stopped_app(pid);
    while named.is_none() && started.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(20));
        named = stopped_app(pid);
    }
    child.kill().expect("the child is ended by pid");
    child.wait().expect("the child is reaped");
    assert!(stopped, "the stop signal was delivered");
    assert_eq!(named.as_deref(), Some("sleep"));
}
