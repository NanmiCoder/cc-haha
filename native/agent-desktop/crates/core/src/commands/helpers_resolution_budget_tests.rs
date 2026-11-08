use super::*;
use std::sync::Mutex;

#[derive(Default)]
struct BudgetAdapter {
    received: Mutex<Vec<(u64, bool)>>,
}

impl ObservationOps for BudgetAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.received
            .lock()
            .unwrap()
            .push((deadline.timeout_ms(), deadline.was_capped()));
        Ok(NativeHandle::null())
    }
}
impl ActionOps for BudgetAdapter {}
impl InputOps for BudgetAdapter {}
impl SystemOps for BudgetAdapter {}

#[test]
fn single_attempt_resolution_receives_the_callers_budget_without_poll_slicing() {
    let adapter = BudgetAdapter::default();
    for timeout in [5_000, 100] {
        resolve_handle_within_deadline(
            &adapter,
            &entry(),
            crate::Deadline::detached_after(timeout).unwrap(),
        )
        .unwrap();
    }
    assert_eq!(
        *adapter.received.lock().unwrap(),
        [(5_000, false), (100, false)]
    );
}

#[test]
fn expired_single_attempt_budget_never_calls_the_adapter() {
    let adapter = BudgetAdapter::default();
    let deadline = crate::Deadline::at(
        std::time::Instant::now() - std::time::Duration::from_secs(1),
        1,
    )
    .unwrap();
    let Err(error) = resolve_handle_within_deadline(&adapter, &entry(), deadline) else {
        panic!("expired resolution must fail");
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(adapter.received.lock().unwrap().is_empty());
}
