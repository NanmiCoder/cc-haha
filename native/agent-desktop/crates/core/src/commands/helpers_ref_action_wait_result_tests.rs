use super::*;

#[test]
fn post_action_wait_without_flag_returns_action_only() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    refmap.allocate(entry());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = ScopedWaitAdapter::new();
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let value = execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["action"], "ok");
    assert!(value.get("after_action").is_none());
}

#[test]
fn post_action_wait_timeout_embeds_action_result_in_details() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    let mut entry = entry();
    entry.source.source_app = Some("TargetApp".into());
    refmap.allocate(entry);
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = ScopedWaitAdapter::new();
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: ":never-appears".into(),
        gone: false,
        timeout_ms: 50,
    }));
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let err = execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &context,
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    let details = match err {
        crate::AppError::Adapter(adapter_err) => adapter_err.details.expect("details"),
        other => panic!("expected adapter timeout, got {other:?}"),
    };
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["after_action"]["action"], "ok");
}

fn failing_wait_delivery(result: crate::ActionResult) -> (crate::DeliverySemantics, Value) {
    let adapter = ScopedWaitAdapter::new();
    let context = CommandContext::default().with_wait_selector(Some(WaitSelector {
        query_raw: ":never-appears".into(),
        gone: false,
        timeout_ms: 50,
    }));
    let err = apply_scoped_post_action_wait(
        serde_json::to_value(result).unwrap(),
        Some("TargetApp".into()),
        None,
        &adapter,
        &context,
    )
    .unwrap_err();
    let crate::AppError::Adapter(error) = err else {
        panic!("expected adapter timeout")
    };
    (error.disposition, error.details.expect("details"))
}

#[test]
fn failed_wait_keeps_a_verified_delivery() {
    let verified = crate::ActionResult::delivered_unverified("move").with_verified_delivery();

    let (disposition, details) = failing_wait_delivery(verified);

    assert_eq!(disposition, crate::DeliverySemantics::delivered_verified());
    assert_eq!(
        details["after_action"]["disposition"]["delivery"],
        "delivered_verified"
    );
}

#[test]
fn failed_wait_keeps_a_satisfied_no_op_as_not_delivered() {
    let satisfied = crate::ActionResult::satisfied_without_delivery("minimize");

    let (disposition, _) = failing_wait_delivery(satisfied);

    assert_eq!(disposition, crate::DeliverySemantics::not_delivered());
}

#[test]
fn failed_wait_after_unverified_delivery_stays_unsafe_to_retry() {
    let unverified = crate::ActionResult::delivered_unverified("click");

    let (disposition, _) = failing_wait_delivery(unverified);

    assert_eq!(
        disposition,
        crate::DeliverySemantics::delivered_unverified()
    );
}
