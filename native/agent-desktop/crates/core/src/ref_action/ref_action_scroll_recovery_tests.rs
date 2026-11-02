use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::ref_action::*;
use crate::{
    ErrorCode, actions::action::Action, actions::action_result::ActionResult, actions::capability,
    refs::RefEntry, snapshot::snapshot_surface::SnapshotSurface, tree::element_state::ElementState,
};
use std::sync::atomic::{AtomicU32, Ordering};

struct ScrollRecoveryAdapter {
    live_calls: AtomicU32,
    resolve_calls: AtomicU32,
    scroll_calls: AtomicU32,
    dispatch_calls: AtomicU32,
    stays_offscreen: bool,
    scroll_should_fail: bool,
}

impl ScrollRecoveryAdapter {
    fn new(stays_offscreen: bool, scroll_should_fail: bool) -> Self {
        Self {
            live_calls: AtomicU32::new(0),
            resolve_calls: AtomicU32::new(0),
            scroll_calls: AtomicU32::new(0),
            dispatch_calls: AtomicU32::new(0),
            stays_offscreen,
            scroll_should_fail,
        }
    }
}

impl ObservationOps for ScrollRecoveryAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        let call = self.live_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let offscreen = self.stays_offscreen || call == 1;
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity("File"),
            state: ElementState {
                role: "menuitem".into(),
                states: Vec::new(),
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(offscreen),
            },
            states_complete: false,
            bounds: Some(bounds()),
            available_actions: vec![capability::EXPAND.into()],
        })
    }
}

impl ActionOps for ScrollRecoveryAdapter {
    fn scroll_into_view(
        &self,
        _handle: &NativeHandle,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scroll_calls.fetch_add(1, Ordering::SeqCst);
        if self.scroll_should_fail {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "ScrollIntoView is not available on this element",
            )
            .with_suggestion(
                "scroll a containing viewport first, or target a scroll-item control",
            ));
        }
        Ok(())
    }

    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("expand"))
    }
}

impl InputOps for ScrollRecoveryAdapter {}
impl SystemOps for ScrollRecoveryAdapter {
    crate::adapter::guarded_interaction_lease!();
}

fn bounds() -> crate::Rect {
    crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    }
}

fn entry() -> RefEntry {
    let bounds = bounds();
    let mut entry = crate::adapter::minimal_ref_entry("menuitem", Some("File"));
    entry.geometry = crate::RefGeometry {
        bounds_space: None,
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
    };
    entry.capabilities.available_actions = vec![capability::EXPAND.into()];
    entry.source = crate::RefSource {
        source_app: Some("Notepad".into()),
        source_window_id: Some("w-1".into()),
        source_window_title: Some("Notepad".into()),
        source_window_bounds_hash: None,
        source_surface: SnapshotSurface::Window,
    };
    entry
}

#[test]
fn failed_scroll_recovery_surfaces_the_original_actionability_error() {
    let adapter = ScrollRecoveryAdapter::new(true, true);

    let error =
        execute_entry(&adapter, &entry(), ActionRequest::headless(Action::Expand)).unwrap_err();

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error.message.contains("not actionable"),
        "expected the actionability diagnosis, got: {}",
        error.message
    );
    assert!(
        error.message.contains("visible"),
        "expected the failed visible check named in the message, got: {}",
        error.message
    );
    assert!(
        !error.message.contains("ScrollIntoView"),
        "the scroll recovery failure must not replace the actionability message, got: {}",
        error.message
    );
    let attempted = error
        .details
        .as_ref()
        .and_then(|details| details.get("scroll_into_view_attempted"))
        .expect("scroll attempt should be recorded as a detail on the original error");
    assert_eq!(
        attempted.get("message").and_then(serde_json::Value::as_str),
        Some("ScrollIntoView is not available on this element")
    );
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn scroll_recovery_success_lets_the_action_proceed() {
    let adapter = ScrollRecoveryAdapter::new(false, false);

    let result = execute_entry(&adapter, &entry(), ActionRequest::headless(Action::Expand))
        .expect("action should dispatch once the recovered target is actionable");

    assert_eq!(result.action, "expand");
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn scroll_recovery_that_leaves_the_target_unactionable_still_fails() {
    let adapter = ScrollRecoveryAdapter::new(true, false);

    let error =
        execute_entry(&adapter, &entry(), ActionRequest::headless(Action::Expand)).unwrap_err();

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error.message.contains("not actionable"),
        "expected the second preflight's own diagnosis, got: {}",
        error.message
    );
    assert!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("scroll_into_view_attempted"))
            .is_none(),
        "a genuine second-preflight failure must not be dressed up as a failed recovery"
    );
    assert_eq!(adapter.scroll_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 2);
}
