use super::*;

struct TransientUnresponsiveAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for TransientUnresponsiveAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        let call = self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            return Err(AdapterError::app_unresponsive("Original")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for TransientUnresponsiveAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for TransientUnresponsiveAdapter {}
impl SystemOps for TransientUnresponsiveAdapter {
    crate::adapter::guarded_interaction_lease!();
}

#[test]
fn auto_wait_retries_a_transiently_unresponsive_accessibility_service() {
    let adapter = TransientUnresponsiveAdapter {
        resolve_calls: AtomicU32::new(0),
    };

    let result = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(5_000)),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap();

    assert_eq!(result.action, "click");
    assert!(adapter.resolve_calls.load(Ordering::SeqCst) >= 2);
}
