use super::*;
use crate::{ActionOps, Deadline, InputOps, ObservationOps, SystemOps};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct RacingToggle {
    initial: bool,
    checked: AtomicBool,
    writes: AtomicUsize,
    dispatched: AtomicBool,
}

impl ObservationOps for RacingToggle {
    fn get_live_element(&self, _: &NativeHandle, _: Deadline) -> Result<LiveElement, AdapterError> {
        let checked = if self.dispatched.load(Ordering::SeqCst) {
            self.checked.load(Ordering::SeqCst)
        } else {
            self.initial
        };
        Ok(LiveElement {
            identity: crate::adapter::live_identity("Mouse Acceleration"),
            state: crate::ElementState {
                role: "switch".into(),
                states: if checked {
                    vec!["checked".into()]
                } else {
                    vec![]
                },
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: None,
            available_actions: vec![],
        })
    }
}

impl ActionOps for RacingToggle {
    fn execute_action(
        &self,
        _: &NativeHandle,
        request: ActionRequest,
        _: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        assert!(!self.dispatched.swap(true, Ordering::SeqCst));
        self.checked.store(!self.initial, Ordering::SeqCst);
        let wanted = match request.action {
            Action::Toggle => !self.checked.load(Ordering::SeqCst),
            Action::Check => true,
            Action::Uncheck => false,
            _ => panic!("unexpected action"),
        };
        if self.checked.swap(wanted, Ordering::SeqCst) == wanted {
            Ok(ActionResult::satisfied_without_delivery(
                request.action.name(),
            ))
        } else {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(ActionResult::delivered_unverified(request.action.name()))
        }
    }
}

impl InputOps for RacingToggle {}
impl SystemOps for RacingToggle {}

#[test]
fn toggle_uses_one_desired_state_when_state_changes_before_dispatch() {
    for initial in [true, false] {
        let adapter = RacingToggle {
            initial,
            checked: AtomicBool::new(initial),
            writes: AtomicUsize::new(0),
            dispatched: AtomicBool::new(false),
        };
        let result = execute_verified_action(
            &adapter,
            &NativeHandle::null(),
            ActionRequest::headless(Action::Toggle),
            &InteractionLease::guarded(Deadline::after(5_000).unwrap(), ()).unwrap(),
        )
        .unwrap();
        assert_eq!(result.action, "toggle");
        assert_eq!(result.disposition(), DeliverySemantics::not_delivered());
        assert_eq!(adapter.checked.load(Ordering::SeqCst), !initial);
        assert_eq!(adapter.writes.load(Ordering::SeqCst), 0);
    }
}
