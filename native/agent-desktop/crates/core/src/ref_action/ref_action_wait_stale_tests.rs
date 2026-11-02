use super::*;

struct CompleteNoCandidateAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for CompleteNoCandidateAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Err(
            AdapterError::stale_ref_because("No candidate").with_details(serde_json::json!({
                "kind": "resolve_no_candidate",
                "complete": true,
                "retryable": true,
            })),
        )
    }

    crate::adapter::complete_live_observation!("menubutton", "Advanced", [capability::EXPAND]);
}

impl ActionOps for CompleteNoCandidateAdapter {}
impl InputOps for CompleteNoCandidateAdapter {}
impl SystemOps for CompleteNoCandidateAdapter {}

#[test]
fn expand_complete_no_candidate_fails_immediately_with_stale_ref() {
    let adapter = CompleteNoCandidateAdapter {
        resolve_calls: AtomicU32::new(0),
    };
    let started = std::time::Instant::now();
    let error = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Expand).with_timeout_ms(Some(5_000)),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
}

#[test]
fn incomplete_resolution_still_polls_until_success() {
    let adapter = RetryAdapter {
        resolve_calls: AtomicU32::new(0),
    };
    let result = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request_with_timeout(5_000),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap();

    assert_eq!(result.action, "click");
    assert!(adapter.resolve_calls.load(Ordering::SeqCst) >= 3);
}
