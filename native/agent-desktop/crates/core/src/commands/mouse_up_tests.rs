use super::*;
use crate::AdapterError;
use crate::MouseEvent;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::sync::Mutex;

struct ModifierCaptureAdapter {
    captured: Mutex<Option<MouseEvent>>,
}

impl ModifierCaptureAdapter {
    fn new() -> Self {
        Self {
            captured: Mutex::new(None),
        }
    }
}

impl ObservationOps for ModifierCaptureAdapter {}
impl ActionOps for ModifierCaptureAdapter {}
impl SystemOps for ModifierCaptureAdapter {}

impl InputOps for ModifierCaptureAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        *self.captured.lock().unwrap() = Some(event);
        Ok(crate::adapter::test_report())
    }
}

#[test]
fn requested_modifiers_do_not_bypass_stateless_rejection() {
    let adapter = ModifierCaptureAdapter::new();

    let err = execute(
        MouseUpArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            modifiers: vec![Modifier::Alt, Modifier::Shift],
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_NOT_SUPPORTED");
    assert!(adapter.captured.lock().unwrap().is_none());
}

#[test]
fn no_modifiers_still_requires_a_daemon_owned_transaction() {
    let adapter = ModifierCaptureAdapter::new();

    let err = execute(
        MouseUpArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_NOT_SUPPORTED");
    assert!(adapter.captured.lock().unwrap().is_none());
}
