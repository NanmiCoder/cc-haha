use agent_desktop_core::{AdapterError, ErrorCode, InteractionPolicy};

use super::{closed_center_policy_error, merge_session_result};

#[test]
fn a_closed_center_is_policy_denied_headlessly() {
    let error = closed_center_policy_error(InteractionPolicy::headless());

    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|value| value.contains("--headed"))
    );
}

#[test]
fn the_operation_error_wins_when_cleanup_also_fails() {
    let operation = AdapterError::new(ErrorCode::ElementNotFound, "operation failed");
    let cleanup = AdapterError::timeout("cleanup failed");

    let error = merge_session_result::<()>(Err(operation), Err(cleanup)).unwrap_err();

    assert_eq!(error.code, ErrorCode::ElementNotFound);
}

#[test]
fn a_cleanup_failure_replaces_an_apparent_operation_success() {
    let cleanup = AdapterError::timeout("cleanup failed");

    let error = merge_session_result(Ok("value"), Err(cleanup)).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn a_clean_cleanup_passes_the_operation_through() {
    let value = merge_session_result(Ok(41), Ok(())).expect("the value survives");

    assert_eq!(value, 41);
}
