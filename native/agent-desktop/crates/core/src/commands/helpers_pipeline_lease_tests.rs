use super::*;

struct PipelineLeaseGuard(Arc<AtomicBool>);

impl Drop for PipelineLeaseGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct CountingPipelineAdapter {
    lease_held: Arc<AtomicBool>,
    calls: Mutex<Vec<String>>,
    drops: Arc<AtomicU32>,
}

impl CountingPipelineAdapter {
    fn new() -> Self {
        Self {
            lease_held: Arc::new(AtomicBool::new(false)),
            calls: Mutex::new(Vec::new()),
            drops: Arc::new(AtomicU32::new(0)),
        }
    }

    fn record(&self, call: &str) {
        let qualifier = if self.lease_held.load(Ordering::SeqCst) {
            "under lease"
        } else {
            "without lease"
        };
        self.calls
            .lock()
            .unwrap()
            .push(format!("{call} {qualifier}"));
    }
}

impl ObservationOps for CountingPipelineAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.record("resolve");
        Ok(NativeHandle::new(DropProbe(Arc::clone(&self.drops))))
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::LiveElement, AdapterError> {
        self.record("live read");
        Ok(crate::adapter::LiveElement {
            identity: crate::adapter::live_identity("OK"),
            state: crate::tree::element_state::ElementState {
                role: "button".into(),
                states: vec![],
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(crate::Rect {
                x: 1.0,
                y: 1.0,
                width: 20.0,
                height: 20.0,
            }),
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        Ok(Some(crate::Rect {
            x: 1.0,
            y: 1.0,
            width: 20.0,
            height: 20.0,
        }))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::ReachesTarget)
    }
}

impl ActionOps for CountingPipelineAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        self.record("execute");
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for CountingPipelineAdapter {}

impl SystemOps for CountingPipelineAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.lease_held
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AdapterError::internal("test lease already held"))?;
        crate::InteractionLease::guarded(deadline, PipelineLeaseGuard(Arc::clone(&self.lease_held)))
    }
}

#[test]
fn ref_action_pipeline_resolves_under_lease_before_dispatch() {
    let _guard = HomeGuard::new();
    let store = crate::refs::refs_store::RefStore::new().unwrap();
    let mut refmap = RefMap::new();
    refmap.allocate(entry());
    let snapshot_id = store.save_new_snapshot(&refmap).unwrap();
    let adapter = CountingPipelineAdapter::new();

    execute_ref_action_result_with_context(
        "@e1",
        Some(&snapshot_id),
        &adapter,
        ActionRequest::headless(Action::Click),
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(
        *adapter.calls.lock().unwrap(),
        [
            "resolve under lease",
            "live read under lease",
            "execute under lease"
        ]
    );
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}
