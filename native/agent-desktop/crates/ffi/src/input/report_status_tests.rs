use crate::adapter::{AdAdapter, ad_adapter_destroy, register_adapter};
use crate::error::AdResult;
use crate::input::clipboard::{ad_clear_clipboard, ad_set_clipboard};
use crate::input::drag::ad_drag;
use crate::input::mouse::ad_mouse_event;
use crate::types::{AdDragParams, AdMouseButton, AdMouseEvent, AdMouseEventKind, AdPoint};
use agent_desktop_core::{
    ActionOps, AdapterError, ClipboardContent, Deadline, DragParams, ErrorCode, InputOps,
    InteractionLease, MouseEvent, ObservationOps, OperationReport, OperationTarget, SystemOps,
};
use std::ffi::CString;

#[derive(Clone, Copy)]
enum Outcome {
    Delivered,
    AlreadySatisfied,
    Failed,
}

struct ReportingAdapter(Outcome);

impl ReportingAdapter {
    fn answer(&self) -> Result<OperationReport, AdapterError> {
        match self.0 {
            Outcome::Delivered => Ok(OperationReport::delivered_unverified(
                "test",
                OperationTarget::Clipboard,
            )),
            Outcome::AlreadySatisfied => Ok(OperationReport::satisfied_without_delivery(
                "test",
                OperationTarget::Clipboard,
            )),
            Outcome::Failed => Err(AdapterError::new(ErrorCode::ActionFailed, "refused")),
        }
    }
}

impl ObservationOps for ReportingAdapter {}
impl ActionOps for ReportingAdapter {}

impl SystemOps for ReportingAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

impl InputOps for ReportingAdapter {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.answer()
    }

    fn drag(
        &self,
        _params: DragParams,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.answer()
    }

    fn clear_clipboard(&self, _lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        self.answer()
    }

    fn set_clipboard_content(
        &self,
        _content: &ClipboardContent,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        self.answer()
    }
}

fn statuses(outcome: Outcome) -> [AdResult; 4] {
    let handle = register_adapter(AdAdapter {
        inner: Box::new(ReportingAdapter(outcome)),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let event = AdMouseEvent {
        kind: AdMouseEventKind::Click as i32,
        point: AdPoint { x: 1.0, y: 1.0 },
        button: AdMouseButton::Left as i32,
        click_count: 1,
    };
    let params = AdDragParams {
        from: AdPoint { x: 0.0, y: 0.0 },
        to: AdPoint { x: 5.0, y: 5.0 },
        duration_ms: 0,
        drop_delay_ms: 0,
    };
    let text = CString::new("x").unwrap();
    let result = unsafe {
        [
            ad_mouse_event(handle, &event),
            ad_drag(handle, &params),
            ad_set_clipboard(handle, text.as_ptr()),
            ad_clear_clipboard(handle),
        ]
    };
    unsafe { ad_adapter_destroy(handle) };
    result
}

#[test]
fn delivered_and_already_satisfied_reports_both_read_as_ok_at_the_c_boundary() {
    for outcome in [Outcome::Delivered, Outcome::AlreadySatisfied] {
        assert_eq!(statuses(outcome), [AdResult::Ok; 4]);
    }
}

#[test]
fn an_adapter_error_keeps_its_code_at_the_c_boundary() {
    assert_eq!(statuses(Outcome::Failed), [AdResult::ErrActionFailed; 4]);
}
