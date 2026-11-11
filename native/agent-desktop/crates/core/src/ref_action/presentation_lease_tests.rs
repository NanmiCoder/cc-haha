use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::ref_action::execute_entry_with_context;
use crate::{
    Action, ActionRequest, ActionResult, AdapterError, CommandContext, CursorOverlayControl, Point,
    Rect, RefEntry, actions::capability,
};
use std::sync::Mutex;

#[derive(Debug, PartialEq)]
enum Event {
    Travel(Point),
    Lease,
    Dispatch,
    Effect(Point),
}

#[derive(Default)]
struct LeaseOrderAdapter {
    events: Mutex<Vec<Event>>,
}

impl ObservationOps for LeaseOrderAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for LeaseOrderAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.events.lock().unwrap().push(Event::Dispatch);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for LeaseOrderAdapter {}

impl SystemOps for LeaseOrderAdapter {
    crate::adapter::exact_window_focus!();

    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.events.lock().unwrap().push(Event::Lease);
        crate::InteractionLease::guarded(deadline, ())
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        let destination = control.instruction().unwrap().destination().clone();
        self.events.lock().unwrap().push(if control.is_travel() {
            Event::Travel(destination)
        } else {
            Event::Effect(destination)
        });
        Ok(())
    }
}

fn button_at(bounds: Rect) -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("button", Some("Run"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions = vec![capability::CLICK.into()];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-42".into());
    entry.source.source_window_title = Some("Fixture".into());
    entry
}

fn live_bounds() -> Rect {
    Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    }
}

fn overlay_context() -> CommandContext {
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CommandContext::default().with_cursor_overlay_session("test-session", config)
}

#[test]
fn headless_travel_runs_before_the_lease_so_cursors_do_not_queue_behind_it() {
    let adapter = LeaseOrderAdapter::default();

    execute_entry_with_context(
        &adapter,
        &button_at(live_bounds()),
        ActionRequest::headless(Action::Click),
        &overlay_context(),
    )
    .expect("click succeeds");

    let center = Point { x: 11.0, y: 11.0 };
    assert_eq!(
        *adapter.events.lock().unwrap(),
        [
            Event::Travel(center.clone()),
            Event::Lease,
            Event::Dispatch,
            Event::Effect(center),
        ],
        "the cursor that already reached the target does not travel again under the lease"
    );
}

#[test]
fn a_target_that_moved_since_the_snapshot_gets_a_short_travel_under_the_lease() {
    let adapter = LeaseOrderAdapter::default();
    let stored = Rect {
        x: 101.0,
        ..live_bounds()
    };

    execute_entry_with_context(
        &adapter,
        &button_at(stored),
        ActionRequest::headless(Action::Click),
        &overlay_context(),
    )
    .expect("click succeeds");

    let live_center = Point { x: 11.0, y: 11.0 };
    assert_eq!(
        *adapter.events.lock().unwrap(),
        [
            Event::Travel(Point { x: 111.0, y: 11.0 }),
            Event::Lease,
            Event::Travel(live_center.clone()),
            Event::Dispatch,
            Event::Effect(live_center),
        ]
    );
}

#[test]
fn headed_travel_stays_under_the_lease_because_it_moves_the_real_pointer() {
    let adapter = LeaseOrderAdapter::default();

    execute_entry_with_context(
        &adapter,
        &button_at(live_bounds()),
        ActionRequest::headed(Action::Click),
        &overlay_context().with_headed(true),
    )
    .expect("click succeeds");

    let events = adapter.events.lock().unwrap();
    assert_eq!(events.first(), Some(&Event::Lease));
    assert!(matches!(events.get(1), Some(Event::Travel(_))));
}
