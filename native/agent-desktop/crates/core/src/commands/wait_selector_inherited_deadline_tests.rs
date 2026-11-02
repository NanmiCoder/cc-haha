use super::*;

/// Regression guard for the post-action-wait `lock_timeout` envelope-replacement
/// bug. Under a batch, the wait's deadline is intersected with the inherited
/// batch deadline; once that inherited deadline has expired, the recovery write
/// in `persist_last_built` used to take the inheritance-aware ref-store lock
/// (`Deadline::after(LOCK_TIMEOUT_MS)`), whose budget collapsed to 0, so the
/// uncontested lock returned `lock_timeout` and the `?` in `timeout_response`
/// replaced the intended `wait_timeout` envelope. The fix routes the recovery
/// write through [`RefStore::save_new_snapshot_detached`] (a detached lock
/// deadline) so the `wait_timeout` envelope — with its `snapshot_id` — is
/// always built.
#[test]
fn flicker_path_emits_wait_timeout_under_an_expired_inherited_deadline() {
    let _guard = HomeGuard::new();
    let adapter = FlippingTreeAdapter {
        calls: AtomicUsize::new(0),
        before: window_node(vec![button_node("flicker")]),
        after: window_node(vec![]),
    };
    let inherited = crate::Deadline::after(300).unwrap();
    let _scope = crate::wait::deadline::enter_scope(Some(inherited));

    let err = execute(
        WaitSelectorInput {
            timeout_ms: 30_000,
            ..base_input("button:flicker", false)
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    drop(_scope);

    assert_eq!(err.code(), "TIMEOUT");
    let details = match err {
        AppError::Adapter(adapter_err) => adapter_err.details.expect("timeout details"),
        other => panic!("expected adapter timeout, got {other:?}"),
    };
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["predicate"], "selector");
    let snapshot_id = details["snapshot_id"]
        .as_str()
        .expect("diagnostic snapshot must be persisted via the detached lock");
    assert!(RefStore::new().unwrap().load(Some(snapshot_id)).is_ok());
    assert!(
        adapter.calls.load(Ordering::SeqCst) >= 2,
        "flicker requires two observe_tree calls (observe + build)"
    );
}

/// Symmetric condition — the bug does NOT fire when `last_built` is `None`,
/// because `persist_last_built(None)` short-circuits before touching the lock.
/// The correct `wait_timeout` envelope (no `snapshot_id`, `last_error`
/// carried) must still be produced under an expired inherited deadline,
/// guarding against any future change that routes the `None` path through the
/// lock.
#[test]
fn expired_inherited_deadline_without_a_snapshot_still_emits_wait_timeout() {
    let _guard = HomeGuard::new();
    let inherited = crate::Deadline::after(300).unwrap();
    let _scope = crate::wait::deadline::enter_scope(Some(inherited));

    let err = execute(
        WaitSelectorInput {
            timeout_ms: 30_000,
            ..base_input("button:absent", false)
        },
        &ErrorThenTreeAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    drop(_scope);

    assert_eq!(err.code(), "TIMEOUT");
    let details = match err {
        AppError::Adapter(adapter_err) => adapter_err.details.expect("timeout details"),
        other => panic!("expected adapter timeout, got {other:?}"),
    };
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["predicate"], "selector");
    assert!(
        details.get("snapshot_id").is_none(),
        "no diagnostic snapshot when the adapter never resolves a window, got {details}"
    );
    assert_eq!(details["last_error"]["code"], "APP_NOT_FOUND");
}
