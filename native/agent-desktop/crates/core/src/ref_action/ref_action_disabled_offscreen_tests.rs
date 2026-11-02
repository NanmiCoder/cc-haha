use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::ref_action::*;
use crate::{
    ErrorCode, actions::action::Action, actions::action_result::ActionResult, actions::capability,
    refs::RefEntry, tree::element_state::ElementState,
};
use std::sync::atomic::{AtomicU32, Ordering};

/// A text field below the fold of its window that is disabled and stays so.
struct DisabledBelowTheFold {
    scroll_calls: AtomicU32,
    dispatch_calls: AtomicU32,
}

impl ObservationOps for DisabledBelowTheFold {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        let scrolled = self.scroll_calls.load(Ordering::SeqCst) > 0;
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity(""),
            state: ElementState {
                role: "textfield".into(),
                states: Vec::new(),
                value: Some("4".into()),
                enabled: Some(false),
                hidden: Some(false),
                offscreen: Some(!scrolled),
            },
            states_complete: true,
            bounds: Some(bounds()),
            available_actions: vec![capability::SET_VALUE.into()],
        })
    }
}

impl ActionOps for DisabledBelowTheFold {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scroll_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("set-value"))
    }
}

impl InputOps for DisabledBelowTheFold {}
impl SystemOps for DisabledBelowTheFold {
    crate::adapter::guarded_interaction_lease!();
}

fn bounds() -> crate::Rect {
    crate::Rect {
        x: 1.0,
        y: 900.0,
        width: 80.0,
        height: 20.0,
    }
}

fn entry() -> RefEntry {
    let bounds = bounds();
    let mut entry = crate::adapter::minimal_ref_entry("textfield", None);
    entry.identity.value = Some("4".into());
    entry.geometry = crate::RefGeometry {
        bounds_space: None,
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
    };
    entry.capabilities.available_actions = vec![capability::SET_VALUE.into()];
    entry
}

#[test]
fn a_disabled_field_below_the_fold_waits_out_the_budget_like_one_in_view() {
    let adapter = DisabledBelowTheFold {
        scroll_calls: AtomicU32::new(0),
        dispatch_calls: AtomicU32::new(0),
    };
    let request = ActionRequest::headless(Action::SetValue("7".into())).with_timeout_ms(Some(400));

    let error = execute_entry(&adapter, &entry(), request).unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.expect("timeout details");
    assert_eq!(details["kind"], "actionability_timeout");
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
}
