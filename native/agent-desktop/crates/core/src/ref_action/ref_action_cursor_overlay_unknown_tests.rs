use super::*;

struct UnknownHitCursorAdapter {
    inner: CursorAdapter,
}

impl UnknownHitCursorAdapter {
    fn new(fail_presentation: bool) -> Self {
        Self {
            inner: CursorAdapter::new(fail_presentation),
        }
    }
}

impl ObservationOps for UnknownHitCursorAdapter {
    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.inner.resolve_element_strict(entry, deadline)
    }

    fn get_live_element(
        &self,
        handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        self.inner.get_live_element(handle, deadline)
    }

    fn get_live_state(
        &self,
        handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<Option<crate::ElementState>, AdapterError> {
        self.inner.get_live_state(handle, deadline)
    }

    fn get_element_bounds(
        &self,
        handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        self.inner.get_element_bounds(handle, deadline)
    }

    fn get_live_actions(
        &self,
        handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        self.inner.get_live_actions(handle, deadline)
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::Unknown)
    }
}

impl ActionOps for UnknownHitCursorAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        if request.policy.is_headed() {
            assert!(
                request.verified_point().is_none(),
                "an inconclusive hit-test must not produce a verified point"
            );
        }
        self.inner
            .events
            .lock()
            .unwrap()
            .push(CursorEvent::Dispatch);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for UnknownHitCursorAdapter {}

impl SystemOps for UnknownHitCursorAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.inner.update_cursor_overlay(control)
    }
}

#[test]
fn physical_delivery_without_verified_point_still_presents_the_overlay() {
    let adapter = UnknownHitCursorAdapter::new(false);
    let context = enabled_context().with_headed(true);

    execute_entry_with_context(
        &adapter,
        &entry(),
        ActionRequest::headed(Action::Click),
        &context,
    )
    .expect("click succeeds despite an inconclusive hit-test");

    let presented = adapter.inner.presented.lock().unwrap();
    let center = crate::Point { x: 11.0, y: 11.0 };
    assert_eq!(
        presented.len(),
        2,
        "a headed physical click presents travel and effect at the bounds center"
    );
    for control in presented.iter() {
        assert_eq!(control.instruction().unwrap().destination(), &center);
    }
    drop(presented);
    assert_eq!(
        *adapter.inner.events.lock().unwrap(),
        [
            CursorEvent::Travel,
            CursorEvent::Dispatch,
            CursorEvent::Effect
        ]
    );
}
