use super::*;

fn last_error_message_str() -> Option<String> {
    LAST_ERROR.with(|cell| cell.borrow().as_ref().map(|e| e.message.to_owned_string()))
}

fn last_error_suggestion_str() -> Option<String> {
    LAST_ERROR.with(|cell| {
        cell.borrow().as_ref().and_then(|e| {
            e.suggestion
                .as_ref()
                .map(|s| s.to_string_lossy().into_owned())
        })
    })
}

fn last_error_platform_detail_str() -> Option<String> {
    LAST_ERROR.with(|cell| {
        cell.borrow().as_ref().and_then(|e| {
            e.platform_detail
                .as_ref()
                .map(|s| s.to_string_lossy().into_owned())
        })
    })
}

fn last_error_details_str() -> Option<String> {
    LAST_ERROR.with(|cell| {
        cell.borrow()
            .as_ref()
            .and_then(|e| e.details.as_ref().map(|s| s.to_string_lossy().into_owned()))
    })
}

#[test]
fn test_no_error_initially() {
    clear_last_error();
    assert!(last_error_message_str().is_none());
}

#[test]
fn result_discriminants_preserve_existing_abi_values() {
    assert_eq!(AdResult::ErrInternal as i32, -12);
    assert_eq!(AdResult::ErrSnapshotNotFound as i32, -13);
    assert_eq!(AdResult::ErrPolicyDenied as i32, -14);
    assert_eq!(AdResult::ErrAmbiguousTarget as i32, -15);
    assert_eq!(AdResult::ErrAppUnresponsive as i32, -16);
}

/// Reverse of `error_code_to_result`, kept solely to guard the bijection. The
/// forward map is exhaustive over `ErrorCode`; this exhaustive match over
/// `AdResult` is its mirror, so a new `AdResult` error variant cannot be added
/// without declaring its `ErrorCode` origin here — closing the reverse-drift
/// direction (a new `AdResult` with no `ErrorCode`) the removed cardinality
/// counters approximated.
fn error_code_origin(result: AdResult) -> Option<ErrorCode> {
    Some(match result {
        AdResult::Ok => return None,
        AdResult::ErrPermDenied => ErrorCode::PermDenied,
        AdResult::ErrElementNotFound => ErrorCode::ElementNotFound,
        AdResult::ErrAppNotFound => ErrorCode::AppNotFound,
        AdResult::ErrActionFailed => ErrorCode::ActionFailed,
        AdResult::ErrActionNotSupported => ErrorCode::ActionNotSupported,
        AdResult::ErrStaleRef => ErrorCode::StaleRef,
        AdResult::ErrWindowNotFound => ErrorCode::WindowNotFound,
        AdResult::ErrPlatformNotSupported => ErrorCode::PlatformNotSupported,
        AdResult::ErrTimeout => ErrorCode::Timeout,
        AdResult::ErrInvalidArgs => ErrorCode::InvalidArgs,
        AdResult::ErrNotificationNotFound => ErrorCode::NotificationNotFound,
        AdResult::ErrInternal => ErrorCode::Internal,
        AdResult::ErrSnapshotNotFound => ErrorCode::SnapshotNotFound,
        AdResult::ErrPolicyDenied => ErrorCode::PolicyDenied,
        AdResult::ErrAmbiguousTarget => ErrorCode::AmbiguousTarget,
        AdResult::ErrAppUnresponsive => ErrorCode::AppUnresponsive,
    })
}

#[test]
fn error_code_and_ad_result_error_variants_stay_in_bijection() {
    for result in [
        AdResult::ErrPermDenied,
        AdResult::ErrElementNotFound,
        AdResult::ErrAppNotFound,
        AdResult::ErrActionFailed,
        AdResult::ErrActionNotSupported,
        AdResult::ErrStaleRef,
        AdResult::ErrWindowNotFound,
        AdResult::ErrPlatformNotSupported,
        AdResult::ErrTimeout,
        AdResult::ErrInvalidArgs,
        AdResult::ErrNotificationNotFound,
        AdResult::ErrInternal,
        AdResult::ErrSnapshotNotFound,
        AdResult::ErrPolicyDenied,
        AdResult::ErrAmbiguousTarget,
        AdResult::ErrAppUnresponsive,
    ] {
        let code = error_code_origin(result).expect("error variant must have an ErrorCode origin");
        assert_eq!(
            error_code_to_result(&code),
            result,
            "forward/reverse mapping disagree for {result:?}"
        );
    }
}

#[test]
fn test_set_and_get_error() {
    let err = AdapterError::new(ErrorCode::ElementNotFound, "element @e5 gone")
        .with_suggestion("run snapshot");
    set_last_error(&err);
    assert_eq!(last_error_code(), AdResult::ErrElementNotFound);
    assert_eq!(last_error_message_str().unwrap(), "element @e5 gone");
    assert_eq!(last_error_suggestion_str().unwrap(), "run snapshot");
    assert!(last_error_platform_detail_str().is_none());
    assert!(last_error_details_str().is_none());
}

#[test]
fn last_error_preserves_delivery_and_retry_semantics() {
    let err = AdapterError::timeout("clipboard helper timed out")
        .with_disposition(DeliverySemantics::uncertain());
    set_last_error(&err);
    let mut semantics = AdDeliverySemantics::unknown();

    assert_eq!(
        unsafe { ad_last_error_delivery_semantics(&mut semantics) },
        AdResult::Ok
    );
    assert_eq!(
        semantics.delivery,
        crate::types::AdDeliveryDisposition::DeliveryUncertain as i32
    );
    assert_eq!(
        semantics.retry,
        crate::types::AdRetryDisposition::Unsafe as i32
    );
}

#[test]
fn test_set_and_get_structured_details() {
    let err = AdapterError::new(ErrorCode::AmbiguousTarget, "ambiguous").with_details(
        serde_json::json!({
            "candidate_count": 2,
            "role": "button"
        }),
    );
    set_last_error(&err);

    assert_eq!(last_error_code(), AdResult::ErrAmbiguousTarget);
    let details: serde_json::Value =
        serde_json::from_str(&last_error_details_str().unwrap()).unwrap();
    assert_eq!(details["candidate_count"], 2);
    assert_eq!(details["role"], "button");
}

#[test]
fn test_clear_error() {
    let err = AdapterError::internal("oops");
    set_last_error(&err);
    clear_last_error();
    assert!(last_error_message_str().is_none());
}

#[test]
fn test_error_isolation_across_threads() {
    clear_last_error();
    let err = AdapterError::internal("thread1");
    set_last_error(&err);

    let handle = std::thread::spawn(|| last_error_message_str().is_none());
    assert!(handle.join().unwrap(), "other thread should see no error");
    assert_eq!(last_error_message_str().unwrap(), "thread1");
}

#[test]
fn test_interior_nul_falls_back_to_static() {
    let err = AdapterError::new(ErrorCode::Internal, "before\0after");
    set_last_error(&err);
    assert_eq!(
        last_error_message_str().unwrap(),
        "(message contained null byte)"
    );
}
