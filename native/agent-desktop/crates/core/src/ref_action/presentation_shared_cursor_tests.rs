use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::ref_action::execute_entry_with_context;
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    Action, ActionRequest, ActionResult, AdapterError, CommandContext, CursorOverlayControl, Rect,
    RefEntry, actions::capability,
};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
enum Event {
    Travel,
    Lease,
    Dispatch,
    Effect,
}

#[derive(Default)]
struct TimedAdapter {
    events: Mutex<Vec<(Event, Instant)>>,
}

impl TimedAdapter {
    fn record(&self, event: Event) {
        self.events.lock().unwrap().push((event, Instant::now()));
    }

    fn first(&self, wanted: Event) -> Instant {
        self.events
            .lock()
            .unwrap()
            .iter()
            .find(|(event, _)| *event == wanted)
            .map(|(_, at)| *at)
            .expect("the event happened")
    }
}

impl ObservationOps for TimedAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for TimedAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.record(Event::Dispatch);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for TimedAdapter {}

impl SystemOps for TimedAdapter {
    crate::adapter::exact_window_focus!();

    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        self.record(Event::Lease);
        crate::InteractionLease::guarded(deadline, ())
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.record(if control.is_travel() {
            Event::Travel
        } else {
            Event::Effect
        });
        Ok(())
    }
}

fn button() -> RefEntry {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("button", Some("Run"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions = vec![capability::CLICK.into()];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-42".into());
    entry.source.source_window_title = Some("Fixture".into());
    entry
}

/// A session whose state is on disk, so its cursor can be shared and locked.
fn session(id: &str) -> CommandContext {
    let store = crate::refs::refs_store::RefStore::for_session(Some(id)).expect("a session store");
    std::fs::create_dir_all(store.base_dir()).expect("the session directory");
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    CommandContext::default().with_cursor_overlay_session(id, config)
}

fn hold_elsewhere_for(context: &CommandContext, hold: Duration) -> Instant {
    let deadline = crate::Deadline::after(1_000).expect("a deadline");
    let lock = crate::cursor_overlay::hold_cursor(context, deadline)
        .expect("the cursor lock")
        .expect("a shared cursor");
    let released = Instant::now() + hold;
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        drop(lock);
    });
    released
}

/// Another command in the same session is between its travel and its click.
/// This one must not move their shared cursor until that command is done, or
/// the other click would land while the cursor shows this target.
#[test]
fn a_command_sharing_the_cursor_waits_for_the_one_already_using_it() {
    let _home = HomeGuard::new();
    let context = session("run-shared");
    let released = hold_elsewhere_for(&context, Duration::from_millis(150));
    let adapter = TimedAdapter::default();

    execute_entry_with_context(
        &adapter,
        &button(),
        ActionRequest::headless(Action::Click),
        &context,
    )
    .expect("click succeeds");

    assert!(adapter.first(Event::Travel) >= released);
    assert!(adapter.first(Event::Travel) <= adapter.first(Event::Lease));
}

/// Separate sessions draw separate cursors, so one session's command in
/// flight does not hold back another session's travel.
#[test]
fn a_command_in_another_session_travels_without_waiting() {
    let _home = HomeGuard::new();
    let busy = session("run-busy");
    let other = session("run-other");
    let released = hold_elsewhere_for(&busy, Duration::from_millis(400));
    let adapter = TimedAdapter::default();

    execute_entry_with_context(
        &adapter,
        &button(),
        ActionRequest::headless(Action::Click),
        &other,
    )
    .expect("click succeeds");

    assert!(adapter.first(Event::Travel) < released);
    assert!(adapter.first(Event::Travel) <= adapter.first(Event::Lease));
}
