use super::super::{MouseClickArgs, execute};
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, CommandContext, MouseButton, MouseEvent};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Default)]
struct TimedLeaseAdapter {
    leased_at: Mutex<Option<Instant>>,
}

impl ObservationOps for TimedLeaseAdapter {}
impl ActionOps for TimedLeaseAdapter {}

impl SystemOps for TimedLeaseAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        *self.leased_at.lock().unwrap() = Some(Instant::now());
        crate::InteractionLease::guarded(deadline, ())
    }

    fn update_cursor_overlay(
        &self,
        _control: &crate::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        Ok(())
    }
}

impl InputOps for TimedLeaseAdapter {
    fn mouse_event(
        &self,
        _event: MouseEvent,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        Ok(crate::adapter::test_report())
    }
}

/// A ref action in the same session is between its travel and its click.
/// A raw mouse click moves the same drawn cursor, so it waits for that action
/// to finish rather than moving the cursor away before the action clicks.
#[test]
fn a_mouse_click_waits_for_the_command_already_using_the_cursor() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let session = crate::session::start_session(Default::default()).expect("session starts");
    let config = crate::CursorOverlayConfig::enabled(None, 6).expect("valid config");
    crate::session::set_cursor_overlay(&session.id, config).expect("overlay enabled");
    let context = CommandContext::new(Some(session.id), None, false)
        .expect("context loads")
        .with_headed(true);
    let lock = crate::cursor_overlay::hold_cursor(&context, crate::Deadline::after(1_000).unwrap())
        .expect("the cursor lock")
        .expect("a shared cursor");
    let hold = Duration::from_millis(150);
    let released = Instant::now() + hold;
    std::thread::spawn(move || {
        std::thread::sleep(hold);
        drop(lock);
    });
    let adapter = TimedLeaseAdapter::default();

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

    let leased_at = adapter
        .leased_at
        .lock()
        .unwrap()
        .expect("the lease was taken");
    assert!(
        leased_at >= released,
        "the click took the lease while the cursor was in use"
    );
}
