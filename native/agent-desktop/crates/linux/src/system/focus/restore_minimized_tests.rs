use std::cell::{Cell, RefCell};
use std::time::Duration;

use super::*;
use crate::tree::Extents;

struct World {
    hidden_reads: Cell<u32>,
    clear_after: u32,
    activations: Cell<u32>,
    activation: Result<(), ControlError>,
    reads: RefCell<Vec<u32>>,
    unreadable: bool,
}

impl World {
    fn clearing_after(reads: u32) -> Self {
        Self {
            hidden_reads: Cell::new(0),
            clear_after: reads,
            activations: Cell::new(0),
            activation: Ok(()),
            reads: RefCell::new(Vec::new()),
            unreadable: false,
        }
    }

    fn never_clearing() -> Self {
        Self::clearing_after(u32::MAX)
    }
}

impl LiftWorld for World {
    fn activate(&self, client: u32, _deadline: Deadline) -> Result<(), ControlError> {
        self.activations.set(self.activations.get() + 1);
        self.reads.borrow_mut().push(client);
        self.activation
    }

    fn facts(&self, _client: u32, _deadline: Deadline) -> ControlRead<WindowFacts> {
        if self.unreadable {
            return ControlRead::Unavailable;
        }
        let seen = self.hidden_reads.get();
        self.hidden_reads.set(seen + 1);
        ControlRead::Ready(WindowFacts {
            client: Extents {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            },
            hidden: seen < self.clear_after,
            maximized_vertical: false,
            maximized_horizontal: false,
        })
    }

    fn manager(&self, _deadline: Deadline) -> Option<String> {
        Some("Mutter".to_owned())
    }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::from_duration(Duration::from_millis(ms)).expect("a deadline builds")
}

#[test]
fn a_flag_that_clears_inside_the_budget_is_cleared() {
    let world = World::clearing_after(2);
    let lifted = lift_via(&world, 42, deadline(5_000)).expect("a lift");
    assert_eq!(lifted, Lifted::Cleared);
    assert_eq!(world.activations.get(), 1);
    assert_eq!(*world.reads.borrow(), vec![42]);
}

#[test]
fn a_flag_that_stays_set_is_still_hidden_and_names_the_manager() {
    let world = World::never_clearing();
    let lifted = lift_via(&world, 42, deadline(5_000)).expect("a lift");
    assert_eq!(
        lifted,
        Lifted::StillHidden {
            manager: "Mutter".to_owned()
        }
    );
}

#[test]
fn a_request_that_cannot_be_sent_is_not_delivered_and_reads_nothing() {
    let mut world = World::never_clearing();
    world.activation = Err(ControlError::NoDisplay);
    let error = lift_via(&world, 7, deadline(5_000)).expect_err("a refusal");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(world.hidden_reads.get(), 0);
}

#[test]
fn a_restore_send_without_confirmation_is_uncertain_and_requires_readback() {
    let mut world = World::never_clearing();
    world.activation = Err(ControlError::SendFailed);
    let error = lift_via(&world, 7, deadline(5_000)).expect_err("unknown delivery");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert!(
        error
            .suggestion
            .expect("readback advice")
            .contains("list-windows")
    );
}

#[test]
fn a_window_that_cannot_be_read_back_is_unknown_not_refused_by_the_manager() {
    let mut world = World::never_clearing();
    world.unreadable = true;
    let error = lift_via(&world, 7, deadline(200)).expect_err("no read-back");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(
        error.details.expect("details")["cause"],
        "readback_unavailable"
    );
}
