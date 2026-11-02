use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, CommandContext, DeliverySemantics, ErrorCode, InteractionLease, MouseEvent,
};
use serde_json::json;

struct NoPointerAdapter {
    sent: AtomicUsize,
}

impl NoPointerAdapter {
    fn new() -> Self {
        Self {
            sent: AtomicUsize::new(0),
        }
    }
}

impl ObservationOps for NoPointerAdapter {}

impl ActionOps for NoPointerAdapter {}

impl InputOps for NoPointerAdapter {
    fn physical_pointer_refusal(&self) -> Option<AdapterError> {
        Some(
            AdapterError::new(
                ErrorCode::ActionNotSupported,
                "Pointer input is not available in this session",
            )
            .with_details(json!({
                "cause": "wayland_session",
                "physical_delivery_started": false,
            }))
            .with_disposition(DeliverySemantics::not_delivered()),
        )
    }

    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        self.sent.fetch_add(1, Ordering::SeqCst);
        Ok(crate::adapter::test_report())
    }
}

impl SystemOps for NoPointerAdapter {}

#[test]
fn a_headed_hover_is_refused_before_the_cursor_is_ever_moved() {
    let adapter = NoPointerAdapter::new();
    let error = hover::execute(
        hover::HoverArgs {
            ref_id: None,
            xy: Some((10.0, 10.0)),
            duration_ms: None,
            timeout_ms: None,
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .expect_err("a session without pointer input must refuse the hover");

    assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
    assert_eq!(adapter.sent.load(Ordering::SeqCst), 0);
}

#[test]
fn a_headed_mouse_move_is_refused_before_the_cursor_is_ever_moved() {
    let adapter = NoPointerAdapter::new();
    let error = mouse_move::execute(
        mouse_move::MouseMoveArgs { x: 10.0, y: 10.0 },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .expect_err("a session without pointer input must refuse the move");

    assert_eq!(error.code(), "ACTION_NOT_SUPPORTED");
    assert_eq!(adapter.sent.load(Ordering::SeqCst), 0);
}

#[test]
fn a_headed_ref_click_is_refused_before_target_resolution() {
    let adapter = NoPointerAdapter::new();
    let error = click::execute(
        helpers::RefArgs {
            ref_id: "@missing:e1".into(),
            timeout_ms: Some(5_000),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .expect_err("the pointer refusal precedes ref loading and actionability");
    let crate::AppError::Adapter(error) = error else {
        panic!("the adapter's pointer refusal must reach the caller");
    };
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(adapter.sent.load(Ordering::SeqCst), 0);
}

fn select_args() -> select::SelectArgs {
    select::SelectArgs {
        ref_id: "@missing:e1".into(),
        value: "Choice".into(),
        timeout_ms: Some(5_000),
    }
}

#[test]
fn a_headed_select_is_refused_before_target_resolution() {
    let adapter = NoPointerAdapter::new();
    let error = select::execute(
        select_args(),
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .expect_err("the pointer refusal precedes ref loading and actionability");
    let crate::AppError::Adapter(error) = error else {
        panic!("the adapter's pointer refusal must reach the caller");
    };
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.details.unwrap()["cause"], "wayland_session");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(adapter.sent.load(Ordering::SeqCst), 0);
}

#[test]
fn a_headless_select_is_not_stopped_by_the_missing_pointer() {
    let _home = crate::refs::refs_test_support::HomeGuard::new();
    let adapter = NoPointerAdapter::new();
    let error = select::execute(select_args(), &adapter, &CommandContext::default())
        .expect_err("the unknown ref is the only refusal of a headless select");
    assert_eq!(error.code(), "SNAPSHOT_NOT_FOUND");
}
