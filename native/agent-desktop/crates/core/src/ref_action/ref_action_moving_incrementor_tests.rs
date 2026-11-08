use crate::adapter::{ActionOps, InputOps, LiveElement, ObservationOps, SystemOps};
use crate::ref_action::*;
use crate::{Action, BoundsSpace, ElementState, RefGeometry, actions::capability};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

/// A value control keeps its native identity while its viewport scrolls.
/// Strict resolution deliberately rejects the old rectangle after that move.
#[derive(Default)]
struct Incrementor {
    scrolled: AtomicBool,
    writes: AtomicU32,
    replace_on_scroll: bool,
}

fn rectangle(scrolled: bool) -> crate::Rect {
    crate::Rect {
        x: 400.0,
        y: if scrolled { 300.0 } else { 900.0 },
        width: 100.0,
        height: 32.0,
    }
}

fn entry() -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("incrementor", None);
    entry.identity.retained_object = Some("/spin".into());
    let bounds = rectangle(false);
    entry.geometry = RefGeometry {
        bounds: Some(bounds),
        bounds_hash: bounds.bounds_hash(),
        bounds_space: Some(BoundsSpace::Window),
    };
    entry.capabilities.available_actions = vec![capability::SET_VALUE.into()];
    entry
}

impl ObservationOps for Incrementor {
    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        _: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if entry.identity.retained_object.as_deref() != Some("/spin")
            || (self.replace_on_scroll && self.scrolled.load(Ordering::SeqCst))
            || entry.geometry.bounds != Some(rectangle(self.scrolled.load(Ordering::SeqCst)))
        {
            return Err(AdapterError::stale_ref_because(
                "the retained rectangle changed",
            ));
        }
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _: &NativeHandle,
        _: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        let scrolled = self.scrolled.load(Ordering::SeqCst);
        let mut identity = crate::adapter::live_identity("");
        identity.identifiers = identity.identifiers.with_retained_object("/spin".into());
        Ok(LiveElement {
            identity,
            state: ElementState {
                role: "incrementor".into(),
                states: Vec::new(),
                value: Some((4 + self.writes.load(Ordering::SeqCst)).to_string()),
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(!scrolled),
            },
            states_complete: true,
            bounds: Some(rectangle(scrolled)),
            available_actions: vec![capability::SET_VALUE.into()],
        })
    }
}

impl ActionOps for Incrementor {
    fn scroll_ref_into_view(
        &self,
        entry: &RefEntry,
        handle: &NativeHandle,
        lease: &crate::InteractionLease,
    ) -> Result<Option<NativeHandle>, AdapterError> {
        self.scroll_into_view(handle, lease)?;
        let mut moved = entry.clone();
        let bounds = rectangle(true);
        moved.geometry.bounds = Some(bounds);
        moved.geometry.bounds_hash = bounds.bounds_hash();
        self.resolve_element_strict(&moved, lease.deadline())
            .map(Some)
    }

    fn scroll_into_view(
        &self,
        _: &NativeHandle,
        _: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        self.scrolled.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn execute_action(
        &self,
        _: &NativeHandle,
        request: ActionRequest,
        _: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        assert!(matches!(request.action, Action::SetValue(value) if value == "5"));
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("set-value"))
    }
}
impl InputOps for Incrementor {}
impl SystemOps for Incrementor {
    crate::adapter::guarded_interaction_lease!();
}

#[test]
fn a_moving_incrementor_commits_once_after_its_own_verified_scroll() {
    let adapter = Incrementor::default();
    execute_entry(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::SetValue("5".into())),
    )
    .expect("a proven viewport move must not invalidate the retained control");
    assert_eq!(adapter.writes.load(Ordering::SeqCst), 1);
}

#[test]
fn a_replacement_incrementor_at_the_expected_scrolled_rectangle_receives_no_write() {
    let adapter = Incrementor {
        replace_on_scroll: true,
        ..Default::default()
    };
    let error = execute_entry(
        &adapter,
        &entry(),
        ActionRequest::headless(Action::SetValue("5".into())),
    )
    .expect_err("scrolling cannot authorize a replacement control");
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(adapter.writes.load(Ordering::SeqCst), 0);
}
