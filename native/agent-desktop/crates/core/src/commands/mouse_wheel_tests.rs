use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{Modifier, MouseEvent, MouseEventKind};
use std::sync::Mutex;

#[derive(Debug, PartialEq)]
struct WheelCall {
    x: f64,
    y: f64,
    dy: f64,
    dx: f64,
    modifiers: Vec<Modifier>,
}

struct WheelCaptureAdapter {
    captured: Mutex<Option<WheelCall>>,
    presented: Mutex<Vec<crate::CursorOverlayControl>>,
    failure: Option<crate::DeliverySemantics>,
}

impl WheelCaptureAdapter {
    fn recording() -> Self {
        Self {
            captured: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
            failure: None,
        }
    }

    fn failing() -> Self {
        Self {
            captured: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
            failure: Some(crate::DeliverySemantics::not_delivered()),
        }
    }

    fn failing_after_delivery() -> Self {
        Self {
            captured: Mutex::new(None),
            presented: Mutex::new(Vec::new()),
            failure: Some(crate::DeliverySemantics::delivered_unverified()),
        }
    }
}

impl ObservationOps for WheelCaptureAdapter {}
impl ActionOps for WheelCaptureAdapter {}
impl SystemOps for WheelCaptureAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn update_cursor_overlay(
        &self,
        control: &crate::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        self.presented.lock().unwrap().push(control.clone());
        Ok(())
    }
}

impl InputOps for WheelCaptureAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        let MouseEventKind::Wheel { delta_x, delta_y } = event.kind else {
            return Err(AdapterError::not_supported("non-wheel mouse event"));
        };
        *self.captured.lock().unwrap() = Some(WheelCall {
            x: event.point.x,
            y: event.point.y,
            dy: delta_y,
            dx: delta_x,
            modifiers: event.modifiers,
        });
        if let Some(disposition) = self.failure {
            return Err(AdapterError::not_supported("mouse_wheel").with_disposition(disposition));
        }
        Ok(crate::adapter::test_report())
    }
}

#[test]
fn requested_wheel_args_reach_the_adapter_unchanged() {
    let adapter = WheelCaptureAdapter::recording();

    execute(
        MouseWheelArgs {
            x: 10.0,
            y: 20.0,
            dy: -3.0,
            dx: 5.0,
            modifiers: vec![Modifier::Shift, Modifier::Alt],
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    let captured = adapter.captured.lock().unwrap();
    let call = captured
        .as_ref()
        .expect("mouse_wheel must have been called");
    assert_eq!(
        *call,
        WheelCall {
            x: 10.0,
            y: 20.0,
            dy: -3.0,
            dx: 5.0,
            modifiers: vec![Modifier::Shift, Modifier::Alt],
        }
    );
}

#[test]
fn returns_scrolled_envelope_with_requested_deltas() {
    let adapter = WheelCaptureAdapter::recording();

    let value = execute(
        MouseWheelArgs {
            x: 0.0,
            y: 0.0,
            dy: 7.0,
            dx: -2.0,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap();

    assert_eq!(value["dy"], 7.0);
    assert_eq!(value["dx"], -2.0);
    assert_eq!(value["disposition"]["delivery"], "delivered_unverified");
    assert!(value.get("scrolled").is_none());
}

fn propagated_adapter_error(result: Result<Value, AppError>) -> AdapterError {
    match result.expect_err("the adapter failure must propagate") {
        AppError::Adapter(error) => error,
        other => panic!("expected the adapter error to propagate unchanged, got {other:?}"),
    }
}

#[test]
fn adapter_error_propagates_as_err() {
    let adapter = WheelCaptureAdapter::failing();
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");

    let result = execute(
        MouseWheelArgs {
            x: 1.0,
            y: 2.0,
            dy: 1.0,
            dx: 0.0,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default()
            .with_headed(true)
            .with_cursor_overlay_session("test-session", config),
    );

    let error = propagated_adapter_error(result);
    assert_eq!(error.code, crate::ErrorCode::PlatformNotSupported);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    let presented = adapter.presented.lock().unwrap();
    assert_eq!(presented.len(), 1);
    assert!(presented[0].is_travel());
}

#[test]
fn delivered_error_still_presents_effect_before_propagating() {
    let adapter = WheelCaptureAdapter::failing_after_delivery();
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");

    let result = execute(
        MouseWheelArgs {
            x: 1.0,
            y: 2.0,
            dy: 1.0,
            dx: 0.0,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default()
            .with_headed(true)
            .with_cursor_overlay_session("test-session", config),
    );

    let error = propagated_adapter_error(result);
    assert_eq!(error.code, crate::ErrorCode::PlatformNotSupported);
    assert_eq!(
        error.disposition,
        crate::DeliverySemantics::delivered_unverified()
    );
    let presented = adapter.presented.lock().unwrap();
    assert_eq!(presented.len(), 2);
    assert!(presented[0].is_travel());
    assert_eq!(
        presented[1].instruction().unwrap().phase(),
        crate::CursorPhase::Effect
    );
}

#[test]
fn headless_policy_rejects_wheel_before_adapter_dispatch() {
    let adapter = WheelCaptureAdapter::recording();
    let err = execute(
        MouseWheelArgs {
            x: 1.0,
            y: 2.0,
            dy: -3.0,
            dx: 0.0,
            modifiers: Vec::new(),
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "POLICY_DENIED");
    assert!(adapter.captured.lock().unwrap().is_none());
}
