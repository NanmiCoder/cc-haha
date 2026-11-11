use super::*;

pub(super) const UNCONSUMED_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

pub(super) fn fail_until_the_third_attempt(
    attempts: &mut u64,
    failure: impl FnOnce() -> AdapterError,
) -> Result<Vec<WindowInfo>, AdapterError> {
    *attempts += 1;
    if *attempts == 3 {
        return Err(AdapterError::timeout("window capture timed out"));
    }
    Err(failure())
}

#[test]
fn persistent_appkit_bridge_failure_preserves_operation_and_status() {
    let mut attempts = 0_u64;
    let error = stabilize_global_with(Instant::now() + UNCONSUMED_BUDGET, || {
        fail_until_the_third_attempt(&mut attempts, || {
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "AppKit workspace snapshot failed",
            )
            .with_details(serde_json::json!({
                "kind": "appkit_bridge",
                "operation": "workspace_snapshot",
                "status": 2,
                "failure_field": "application_name",
                "failure_index": 7,
                "failure_pid": 123,
                "retryable": true,
            }))
        })
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["attempts"], 3);
    assert_eq!(details["last_kind"], "appkit_bridge");
    assert_eq!(details["last_operation"], "workspace_snapshot");
    assert_eq!(details["last_status"], 2);
    assert_eq!(details["last_failure_field"], "application_name");
    assert_eq!(details["last_failure_index"], 7);
    assert_eq!(details["last_failure_pid"], 123);
}

#[test]
fn a_failure_without_context_leaves_the_last_failure_fields_out() {
    let mut attempts = 0_u64;
    let error = stabilize_global_with(Instant::now() + UNCONSUMED_BUDGET, || {
        fail_until_the_third_attempt(&mut attempts, || {
            AdapterError::new(
                ErrorCode::AppUnresponsive,
                "AppKit workspace snapshot failed",
            )
            .with_details(serde_json::json!({
                "kind": "appkit_bridge",
                "operation": "workspace_snapshot",
                "status": 1,
                "retryable": true,
            }))
        })
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["attempts"], 3);
    for key in [
        "last_failure_field",
        "last_failure_index",
        "last_failure_pid",
    ] {
        assert!(details.get(key).is_none(), "{key} is omitted, not null");
    }
    assert_eq!(details["last_status"], 1);
}
