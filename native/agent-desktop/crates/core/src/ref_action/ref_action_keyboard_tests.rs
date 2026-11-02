use std::sync::atomic::{AtomicUsize, Ordering};

use crate::{
    Action, ActionOps, ActionRequest, ActionResult, AdapterError, Deadline, ElementState, InputOps,
    InteractionLease, LiveElement, NativeHandle, ObservationOps, RefEntry, SystemOps, WindowInfo,
};

#[derive(Default)]
struct KeyboardAdapter {
    focus_calls: AtomicUsize,
    dispatched: AtomicUsize,
}

impl ObservationOps for KeyboardAdapter {
    fn resolve_element_strict(
        &self,
        _: &RefEntry,
        _: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_element(&self, _: &NativeHandle, _: Deadline) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Field"),
            state: ElementState {
                role: "textfield".into(),
                states: vec![],
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: None,
            available_actions: vec![crate::actions::capability::TYPE_TEXT.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _: &NativeHandle,
        _: Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        Ok(None)
    }
}

impl ActionOps for KeyboardAdapter {
    fn execute_action(
        &self,
        _: &NativeHandle,
        request: ActionRequest,
        _: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        assert!(matches!(request.action, Action::TypeText(_)));
        self.dispatched.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("type"))
    }
}

impl InputOps for KeyboardAdapter {
    fn keyboard_needs_window_activation(&self) -> bool {
        false
    }
}

impl SystemOps for KeyboardAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        window: &WindowInfo,
        _: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(&self, _: &WindowInfo, _: &InteractionLease) -> Result<(), AdapterError> {
        self.focus_calls.fetch_add(1, Ordering::SeqCst);
        Err(AdapterError::not_supported("focus_window"))
    }
}

#[test]
fn a_headed_type_on_a_session_that_cannot_activate_skips_window_focus() {
    let adapter = KeyboardAdapter::default();
    let entry: RefEntry = serde_json::from_value(serde_json::json!({
        "pid": 1, "process_instance": "test-instance", "role": "textfield", "name": "Field",
        "source_window_id": "w-test", "source_surface": "window", "path": [0],
        "available_actions": ["TypeText"], "states": []
    }))
    .unwrap();
    let request =
        ActionRequest::headed(Action::TypeText("hello".into())).with_timeout_ms(Some(2_000));

    crate::ref_action::execute_entry(&adapter, &entry, request).expect("the type is dispatched");

    assert_eq!(adapter.focus_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatched.load(Ordering::SeqCst), 1);
}
