use crate::{AdapterError, AppError, ErrorCode, InteractionPolicy};

#[test]
fn notification_not_found_error_has_correct_code() {
    let error = AdapterError::notification_not_found(5);
    assert_eq!(error.code, ErrorCode::NotificationNotFound);
    assert!(error.message.contains('5'));
    assert!(error.suggestion.is_some());
}

#[test]
fn stale_ref_suggestion_is_transport_neutral() {
    let error = AdapterError::stale_ref("@e7");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(error.message.contains("@e7"));
    let suggestion = error
        .suggestion
        .as_deref()
        .expect("stale_ref should carry a suggestion");
    assert!(suggestion.contains("snapshot"));
    assert!(suggestion.contains("FFI"));
}

#[test]
fn ambiguous_target_error_has_machine_readable_code() {
    let error = AdapterError::ambiguous_target("2 candidates matched");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.code.as_str(), "AMBIGUOUS_TARGET");
    assert!(error.suggestion.is_some());
}

#[test]
fn policy_denied_suggestion_is_mode_aware() {
    let headless = AdapterError::policy_denied_for_policy("blocked", InteractionPolicy::headless());
    assert!(headless.suggestion.unwrap().contains("--headed"));
    let focus =
        AdapterError::policy_denied_for_policy("blocked", InteractionPolicy::focus_fallback());
    assert!(focus.suggestion.unwrap().contains("--headed"));
}

#[test]
fn all_error_codes_as_str_and_serde_are_consistent() {
    let cases = [
        (ErrorCode::PermDenied, "PERM_DENIED"),
        (ErrorCode::ElementNotFound, "ELEMENT_NOT_FOUND"),
        (ErrorCode::AppNotFound, "APP_NOT_FOUND"),
        (ErrorCode::ActionFailed, "ACTION_FAILED"),
        (ErrorCode::ActionNotSupported, "ACTION_NOT_SUPPORTED"),
        (ErrorCode::StaleRef, "STALE_REF"),
        (ErrorCode::AmbiguousTarget, "AMBIGUOUS_TARGET"),
        (ErrorCode::WindowNotFound, "WINDOW_NOT_FOUND"),
        (ErrorCode::PlatformNotSupported, "PLATFORM_NOT_SUPPORTED"),
        (ErrorCode::Timeout, "TIMEOUT"),
        (ErrorCode::InvalidArgs, "INVALID_ARGS"),
        (ErrorCode::NotificationNotFound, "NOTIFICATION_NOT_FOUND"),
        (ErrorCode::SnapshotNotFound, "SNAPSHOT_NOT_FOUND"),
        (ErrorCode::PolicyDenied, "POLICY_DENIED"),
        (ErrorCode::AppUnresponsive, "APP_UNRESPONSIVE"),
        (ErrorCode::Internal, "INTERNAL"),
    ];
    for (code, expected) in cases {
        assert_eq!(code.as_str(), expected);
        assert_eq!(
            serde_json::to_string(&code).unwrap(),
            format!("\"{expected}\"")
        );
    }
}

#[test]
fn non_adapter_app_errors_yield_internal_code_and_no_suggestion() {
    let io_error = AppError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"));
    let json_error =
        AppError::Json(serde_json::from_str::<serde_json::Value>("not json").unwrap_err());
    let internal_error = AppError::Internal("unexpected state".into());

    for error in [&io_error, &json_error, &internal_error] {
        assert_eq!(error.code(), "INTERNAL");
        assert!(error.suggestion().is_none());
    }
}

/// A permission denial reaching the envelope as `INTERNAL` tells a caller the
/// tool broke, when in fact it refused for a reason they can act on. The
/// narrowness matters as much as the mapping: an unrelated io failure must not
/// acquire a confident, wrong label on the way out.
#[test]
fn a_permission_denied_io_error_keeps_its_own_code_and_others_do_not() {
    use std::io::{Error, ErrorKind};

    let denied = AppError::Io(Error::new(ErrorKind::PermissionDenied, "owned elsewhere"));
    assert_eq!(
        denied.code(),
        "PERM_DENIED",
        "a refusal the caller can act on must not read as an internal fault"
    );

    for kind in [
        ErrorKind::NotFound,
        ErrorKind::UnexpectedEof,
        ErrorKind::InvalidData,
    ] {
        let other = AppError::Io(Error::new(kind, "unrelated"));
        assert_eq!(
            other.code(),
            "INTERNAL",
            "{kind:?} carries no caller-actionable meaning and must stay INTERNAL"
        );
    }
}
