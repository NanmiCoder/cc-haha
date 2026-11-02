use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::{
    Action, DeliverySemantics, Rect,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps},
};

struct Positionless {
    refuses: bool,
    asked: AtomicUsize,
}

impl ObservationOps for Positionless {
    fn pointer_position_refusal(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Option<AdapterError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.refuses.then(|| {
            AdapterError::ambiguous_target("two windows share this target's window")
                .with_disposition(DeliverySemantics::not_delivered())
        })
    }
}

impl ActionOps for Positionless {}
impl InputOps for Positionless {}
impl SystemOps for Positionless {}

fn on_screen_without_bounds(bounds: Option<Rect>) -> ActionabilityEvidence {
    ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: "button".into(),
            states: Vec::new(),
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds,
        available_actions: vec![crate::actions::capability::CLICK.to_owned()],
    }
}

fn judge(
    adapter: &Positionless,
    request: &ActionRequest,
    bounds: Option<Rect>,
) -> Result<ActionabilityReport, AdapterError> {
    let handle = NativeHandle::null();
    check_with_stability(
        StabilityExpectation::permissive(bounds.and_then(|bounds| bounds.bounds_hash())),
        &on_screen_without_bounds(bounds),
        request,
        Some((&handle, adapter)),
        crate::Deadline::standard().unwrap(),
    )
}

fn adapter(refuses: bool) -> Positionless {
    Positionless {
        refuses,
        asked: AtomicUsize::new(0),
    }
}

#[test]
fn a_pointer_request_with_no_position_is_refused_with_the_adapters_proof() {
    let positionless = adapter(true);
    let error = judge(&positionless, &ActionRequest::headed(Action::Click), None)
        .expect_err("the position cannot be known");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn without_a_proof_the_missing_position_stays_a_wait() {
    let positionless = adapter(false);
    let error = judge(&positionless, &ActionRequest::headed(Action::Click), None)
        .expect_err("a click with no position is not actionable yet");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(error.message.contains("visible (bounds unavailable)"));
    assert_eq!(positionless.asked.load(Ordering::SeqCst), 1);
}

#[test]
fn a_request_that_needs_no_position_never_asks() {
    let positionless = adapter(true);
    let report = judge(&positionless, &ActionRequest::headless(Action::Click), None)
        .expect("a semantic click needs no position");
    assert!(report.actionable);
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    judge(
        &positionless,
        &ActionRequest::headed(Action::Click),
        Some(bounds),
    )
    .expect("a known position is not refused");
    assert_eq!(positionless.asked.load(Ordering::SeqCst), 0);
}
