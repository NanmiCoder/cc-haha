use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::sync::Mutex;

struct ModifierCaptureAdapter {
    captured: Mutex<Option<MouseEvent>>,
    presented: Mutex<Vec<crate::CursorOverlayControl>>,
}

impl ModifierCaptureAdapter {
    fn new() -> Self {
        Self {
            captured: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for ModifierCaptureAdapter {}
impl ActionOps for ModifierCaptureAdapter {}
impl SystemOps for ModifierCaptureAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn update_cursor_overlay(
        &self,
        control: &crate::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

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

/// F10 regression: `mouse-click` previously hardcoded `modifiers: Vec::new()`
/// in this command, so `--modifiers cmd,shift` was accepted (once parsed)
/// but silently discarded before reaching the adapter. This proves the
/// requested chord survives unchanged into the dispatched `MouseEvent`.
#[test]
fn requested_modifiers_reach_the_dispatched_mouse_event() {
    let adapter = ModifierCaptureAdapter::new();

    execute(
        MouseClickArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            count: 1,
            modifiers: vec![Modifier::Meta, Modifier::Shift],
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    let captured = adapter.captured.lock().unwrap();
    let event = captured
        .as_ref()
        .expect("mouse_event must have been called");
    assert_eq!(event.modifiers, vec![Modifier::Meta, Modifier::Shift]);
}

#[test]
fn no_modifiers_requested_dispatches_empty_modifiers() {
    let adapter = ModifierCaptureAdapter::new();

    execute(
        MouseClickArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            count: 1,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    let captured = adapter.captured.lock().unwrap();
    assert!(captured.as_ref().unwrap().modifiers.is_empty());
}

#[test]
fn headed_mouse_click_presents_agent_cursor_after_delivery() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let adapter = ModifierCaptureAdapter::new();
    let session = crate::session::start_session(Default::default()).expect("session starts");
    let config = crate::CursorOverlayConfig::enabled(None, 6)
        .expect("valid config")
        .with_multi_agent(true);
    crate::session::set_cursor_overlay(&session.id, config).expect("overlay enabled");
    let context = CommandContext::new(Some(session.id), None, false)
        .expect("context loads")
        .with_headed(true)
        .with_agent_id(Some("agent-a".into()))
        .expect("valid agent id");

    execute(
        MouseClickArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            count: 1,
            modifiers: Vec::new(),
        },
        &adapter,
        &context,
    )
    .expect("mouse click succeeds");

    let presented = adapter.presented.lock().unwrap();
    assert_eq!(presented.len(), 2);
    assert!(presented[0].is_travel());
    let control = &presented[1];
    let instruction = control.instruction().expect("present instruction");
    assert_eq!(instruction.destination(), &Point { x: 10.0, y: 20.0 });
    assert!(instruction.is_click());
    assert_eq!(control.agent_id(), Some("agent-a"));
}

#[test]
fn zero_clicks_fail_before_dispatch() {
    let adapter = ModifierCaptureAdapter::new();

    let err = execute(
        MouseClickArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            count: 0,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(adapter.captured.lock().unwrap().is_none());
}

#[test]
fn excessive_click_count_fails_before_dispatch() {
    let adapter = ModifierCaptureAdapter::new();

    let err = execute(
        MouseClickArgs {
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            count: crate::MAX_MOUSE_CLICK_COUNT + 1,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(adapter.captured.lock().unwrap().is_none());
}

#[path = "mouse_click_cursor_tests.rs"]
mod cursor;
