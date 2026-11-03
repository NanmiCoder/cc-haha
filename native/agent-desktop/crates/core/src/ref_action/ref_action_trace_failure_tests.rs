use super::*;

#[test]
fn strict_trace_failure_before_dispatch_is_not_delivered() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-ref-trace-start-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(crate::trace::MAX_TRACE_FILE_BYTES)
        .unwrap();
    let adapter = TraceFailureAdapter {
        path: path.clone(),
        fail_after_dispatch: false,
        dispatches: AtomicU32::new(0),
    };

    let error = execute_entry_with_context(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::Click),
        &context,
    )
    .unwrap_err();

    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn strict_trace_failure_after_dispatch_is_unsafe_to_retry() {
    let path = std::env::temp_dir().join(format!(
        "agent-desktop-ref-trace-end-{}.jsonl",
        crate::refs::new_snapshot_id()
    ));
    let context = CommandContext::new(None, Some(path.clone()), true).unwrap();
    let adapter = TraceFailureAdapter {
        path: path.clone(),
        fail_after_dispatch: true,
        dispatches: AtomicU32::new(0),
    };

    let error = execute_entry_with_context(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::Click),
        &context,
    )
    .unwrap_err();

    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
    assert_eq!(
        error.disposition,
        crate::DeliverySemantics::delivered_unverified()
    );
    std::fs::remove_file(path).unwrap();
}
