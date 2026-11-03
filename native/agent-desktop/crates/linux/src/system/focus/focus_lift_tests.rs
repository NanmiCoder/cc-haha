use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::fake::*;
use super::*;
use crate::system::focus::restore_minimized::Lifted;

fn still_hidden(manager: &str) -> Lifted {
    Lifted::StillHidden {
        manager: manager.to_owned(),
    }
}

#[test]
fn a_minimized_frame_whose_flag_clears_gets_one_activation_and_succeeds() {
    let mut world = World::new(Some(OTHER));
    world.minimized = Some(true);
    run(&world, &window(), budget()).expect("a lifted window continues to the active check");
    assert_eq!(world.lifts(), 1);
    assert_eq!(world.sends(), 1);
}

#[test]
fn a_hidden_client_whose_flag_clears_gets_one_activation_and_succeeds() {
    let mut world = World::new(Some(OTHER));
    world.flags.hidden = true;
    run(&world, &window(), budget()).expect("a lifted window continues to the active check");
    assert_eq!(world.lifts(), 1);
    assert_eq!(world.sends(), 1);
}

#[test]
fn a_lift_that_already_made_the_window_active_sends_no_second_activation() {
    let mut world = World::new(Some(OTHER));
    world.minimized = Some(true);
    world.lift_activates = true;
    run(&world, &window(), budget()).expect("active after the lift");
    assert_eq!(world.lifts(), 1);
    assert_eq!(world.sends(), 0);
}

#[test]
fn a_flag_that_stays_set_is_not_supported_names_the_manager_and_is_no_success() {
    for (minimized, hidden, cause) in [
        (Some(true), false, "window_minimized"),
        (Some(false), true, "window_hidden"),
    ] {
        let mut world = World::new(Some(OTHER));
        world.minimized = minimized;
        world.flags.hidden = hidden;
        world.lifted = still_hidden("Openbox");
        let error = failure(&world);
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.details.as_ref().expect("details")["cause"], cause);
        assert!(error.message.contains("Openbox"), "{}", error.message);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        assert_eq!(world.sends(), 0);
        assert_eq!(world.active.get(), Some(OTHER));
    }
}

#[test]
fn a_never_focused_window_gets_the_stamped_and_the_unstamped_request_and_no_other_write() {
    let mut world = World::new(None);
    world.grant = Grant::Never;
    let error = failure(&world);
    assert_refused(&error, "activation_not_granted");
    assert_eq!(*world.writes.borrow(), vec!["send", "send_untimed"]);
}

#[test]
fn a_lifted_window_that_is_still_not_granted_ends_in_the_per_outcome_refusal() {
    let mut world = World::new(None);
    world.minimized = Some(true);
    world.grant = Grant::Never;
    assert_refused(&failure(&world), "activation_not_granted");
    assert_eq!(*world.writes.borrow(), vec!["lift", "send", "send_untimed"]);
}
