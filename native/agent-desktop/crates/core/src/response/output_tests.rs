use super::*;
use crate::{AdapterError, ErrorCode};
use serde_json::json;

#[test]
fn app_error_payload_preserves_adapter_recovery_fields() {
    let err = AppError::Adapter(
        AdapterError::new(ErrorCode::ActionFailed, "not actionable")
            .with_suggestion("wait and retry")
            .with_platform_detail("native press action failed")
            .with_details(json!({ "check": "visible" })),
    );

    let payload = ErrorPayload::from_app_error(&err);

    assert_eq!(payload.code, "ACTION_FAILED");
    assert_eq!(payload.message, "not actionable");
    assert_eq!(payload.suggestion.as_deref(), Some("wait and retry"));
    assert_eq!(
        payload.platform_detail.as_deref(),
        Some("native press action failed")
    );
    assert_eq!(payload.details, Some(json!({ "check": "visible" })));
    assert_eq!(
        payload.recovery, None,
        "ACTION_FAILED must not carry a retry token"
    );
}

#[test]
fn stale_ref_payload_carries_snapshot_recovery() {
    let err = AppError::stale_ref("@e5");
    let payload = ErrorPayload::from_app_error(&err);
    assert_eq!(payload.code, "STALE_REF");
    assert_eq!(
        payload
            .recovery
            .as_ref()
            .map(|recovery| recovery.strategy.as_str()),
        Some("refresh_snapshot_then_retry_original")
    );
    assert!(
        payload
            .recovery
            .is_some_and(|recovery| recovery.requires_fresh_snapshot)
    );
}

#[test]
fn snapshot_not_found_payload_carries_snapshot_recovery() {
    let err = AppError::Adapter(AdapterError::snapshot_not_found("snap-abc"));
    let payload = ErrorPayload::from_app_error(&err);
    assert_eq!(payload.code, "SNAPSHOT_NOT_FOUND");
    assert_eq!(
        payload
            .recovery
            .as_ref()
            .map(|recovery| recovery.strategy.as_str()),
        Some("refresh_snapshot_then_retry_original")
    );
}

/// The suggestion has to name the namespace rule, because the one workflow
/// that reliably produces this error is a snapshot taken outside a session
/// and acted on inside one — and "re-run a snapshot and retry" sends that
/// caller round the same loop forever. Enabling the cursor overlay is what
/// drags a session into an otherwise session-free workflow, which is how a
/// stranger met this.
#[test]
fn snapshot_not_found_tells_the_caller_that_snapshots_are_session_scoped() {
    let err = AppError::Adapter(AdapterError::snapshot_not_found("snap-abc"));
    let payload = ErrorPayload::from_app_error(&err);

    let suggestion = payload.suggestion.as_deref().unwrap_or_default();
    assert!(
        suggestion.contains("session"),
        "the suggestion must name sessions, or a caller whose snapshot is in the wrong          namespace is told only to do the thing that already failed: {suggestion}"
    );
}

#[test]
fn policy_denied_payload_carries_policy_recovery() {
    let err = AppError::Adapter(AdapterError::policy_denied("blocked by policy"));
    let payload = ErrorPayload::from_app_error(&err);
    assert_eq!(payload.code, "POLICY_DENIED");
    assert_eq!(
        payload
            .recovery
            .as_ref()
            .map(|recovery| recovery.strategy.as_str()),
        Some("request_explicit_policy_then_retry_original")
    );
}

#[test]
fn app_unresponsive_payload_carries_declarative_recovery() {
    let err = AppError::Adapter(AdapterError::app_unresponsive("Finder"));
    let payload = ErrorPayload::from_app_error(&err);
    assert_eq!(payload.code, "APP_UNRESPONSIVE");
    assert_eq!(
        payload
            .recovery
            .as_ref()
            .map(|recovery| recovery.strategy.as_str()),
        Some("inspect_state_then_retry_original")
    );
    assert_eq!(
        payload
            .recovery
            .as_ref()
            .and_then(|recovery| recovery.retry_after_ms),
        Some(250)
    );
}

#[test]
fn safe_timeout_payload_carries_inspect_recovery() {
    let err = AppError::Adapter(
        AdapterError::new(ErrorCode::Timeout, "identity read incomplete")
            .with_disposition(crate::DeliverySemantics::not_delivered()),
    );
    let recovery = ErrorPayload::from_app_error(&err)
        .recovery
        .expect("safe timeout carries recovery");
    assert_eq!(recovery.strategy, "inspect_state_then_retry_original");
    assert_eq!(recovery.retry_after_ms, Some(250));
}

#[test]
fn unsafe_timeout_payload_carries_no_recovery() {
    let err = AppError::Adapter(AdapterError::new(ErrorCode::Timeout, "wait expired"));
    assert!(ErrorPayload::from_app_error(&err).recovery.is_none());
}

#[test]
fn recovery_absent_for_non_retryable_errors() {
    for err in [
        AppError::Adapter(AdapterError::new(ErrorCode::InvalidArgs, "bad input")),
        AppError::Adapter(AdapterError::not_supported("method_x")),
        AppError::Adapter(AdapterError::new(ErrorCode::ActionFailed, "failed")),
    ] {
        let payload = ErrorPayload::from_app_error(&err);
        assert!(
            payload.recovery.is_none(),
            "non-retryable error {} must not carry a retry token",
            payload.code
        );
    }
}

#[test]
fn explicit_nonretryable_refusals_never_acquire_a_retry_token() {
    for code in [
        ErrorCode::StaleRef,
        ErrorCode::Timeout,
        ErrorCode::AppUnresponsive,
    ] {
        let err = AppError::Adapter(
            AdapterError::new(code, "terminal refusal")
                .with_details(json!({ "retryable": false }))
                .with_disposition(DeliverySemantics::not_delivered()),
        );
        let payload = ErrorPayload::from_app_error(&err);
        assert_eq!(payload.details.unwrap()["retryable"], false);
        assert!(
            payload.recovery.is_none(),
            "{} must not invite a retry",
            payload.code
        );
        assert_eq!(payload.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn ok_response_json_shape_has_version_ok_command_data_and_no_error_field() {
    let resp = Response::ok("snapshot", json!({"app": "Finder"}));
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::to_value(&resp).expect("serializable")).expect("map");

    assert_eq!(
        map["version"].as_str(),
        Some(super::ENVELOPE_VERSION),
        "version must track ENVELOPE_VERSION"
    );
    assert_eq!(map["ok"].as_bool(), Some(true), "ok must be true");
    assert_eq!(
        map["command"].as_str(),
        Some("snapshot"),
        "command must match"
    );
    assert!(map.contains_key("data"), "ok response must have data field");
    assert!(
        !map.contains_key("error"),
        "ok response must not serialize an error field (skip_serializing_if = is_none)"
    );
}

#[test]
fn err_response_json_shape_has_version_ok_command_error_and_no_data_field() {
    let payload =
        ErrorPayload::new("STALE_REF", "ref @e1 is stale").with_suggestion("re-run snapshot");
    let resp = Response::err("click", payload);
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::to_value(&resp).expect("serializable")).expect("map");

    assert_eq!(
        map["version"].as_str(),
        Some(super::ENVELOPE_VERSION),
        "version must track ENVELOPE_VERSION"
    );
    assert_eq!(map["ok"].as_bool(), Some(false), "ok must be false");
    assert_eq!(map["command"].as_str(), Some("click"), "command must match");
    assert!(
        !map.contains_key("data"),
        "err response must not serialize a data field (skip_serializing_if = is_none)"
    );
    assert!(
        map.contains_key("error"),
        "err response must have error field"
    );
    assert_eq!(
        map["error"]["code"].as_str(),
        Some("STALE_REF"),
        "error code must round-trip"
    );
    assert_eq!(
        map["error"]["message"].as_str(),
        Some("ref @e1 is stale"),
        "error message must round-trip"
    );
    assert_eq!(
        map["error"]["suggestion"].as_str(),
        Some("re-run snapshot"),
        "suggestion must be present when set"
    );
}

#[test]
fn err_response_omits_optional_error_subfields_when_absent() {
    let payload = ErrorPayload::new("INTERNAL", "something broke");
    let resp = Response::err("snapshot", payload);
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::to_value(&resp).expect("serializable")).expect("map");

    let error = map["error"].as_object().expect("error must be an object");
    assert!(
        !error.contains_key("suggestion"),
        "absent suggestion must be omitted from JSON"
    );
    assert!(
        !error.contains_key("recovery"),
        "absent recovery must be omitted from JSON"
    );
    assert!(
        !error.contains_key("platform_detail"),
        "absent platform_detail must be omitted from JSON"
    );
    assert!(
        !error.contains_key("details"),
        "absent details must be omitted from JSON"
    );
}
