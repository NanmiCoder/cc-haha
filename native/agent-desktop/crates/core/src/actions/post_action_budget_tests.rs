use super::*;

#[test]
fn settling_reuses_caller_deadline_without_repeating_delivery() {
    let adapter = adapter(element(Some("old"), &[]), element(Some("new"), &[]));
    adapter
        .settling
        .lock()
        .unwrap()
        .extend([element(Some("old"), &[]), element(Some("partial"), &[])]);
    let deadline = Deadline::after(1000).unwrap();
    let result = execute_verified_action(
        &adapter,
        &NativeHandle::null(),
        ActionRequest::headless(Action::SetValue("new".into())),
        &InteractionLease::guarded(deadline, ()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(*adapter.reads.lock().unwrap(), vec![deadline; 3]);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn no_settle_read_is_started_without_remaining_budget() {
    let adapter = adapter(element(Some("old"), &[]), element(Some("old"), &[]));
    let error = execute_verified_action(
        &adapter,
        &NativeHandle::null(),
        ActionRequest::headless(Action::Clear),
        &InteractionLease::guarded(Deadline::after(40).unwrap(), ()).unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(adapter.reads.lock().unwrap().len(), 1);
}
