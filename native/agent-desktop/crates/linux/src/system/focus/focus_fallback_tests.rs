use agent_desktop_core::{DeliverySemantics, ErrorCode};

use super::fake::*;
use super::*;

fn writes(world: &World) -> Vec<String> {
    world.writes.borrow().clone()
}

#[test]
fn a_refused_stamped_request_is_followed_by_one_unstamped_request_that_succeeds() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::Never;
    world.untimed_grants = true;
    run(&world, &window(), budget()).expect("the unstamped request is honoured");
    assert_eq!(writes(&world), ["send", "send_untimed"]);
}

#[test]
fn an_unstamped_request_that_is_also_ignored_ends_in_the_refusal_after_exactly_two_requests() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::Never;
    let error = failure(&world);
    assert_refused(&error, "activation_refused");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(writes(&world), ["send", "send_untimed"]);
}

#[test]
fn a_frame_that_stays_inactive_after_the_display_agrees_is_not_retried() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.untimed_grants = true;
    let error = failure(&world);
    assert_refused(&error, "frame_not_active");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_request_that_cannot_be_sent_is_not_retried() {
    let mut world = World::new(Some(OTHER));
    world.send_fails = true;
    world.untimed_grants = true;
    let error = failure(&world);
    assert_refused(&error, "activation_not_sent");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_modal_dialog_that_took_the_focus_is_named_and_never_a_success() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::Never;
    world.untimed_grants = true;
    world.modal = Some("Save changes?".to_owned());
    let error = failure(&world);
    assert_refused(&error, "blocked_by_modal_dialog");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.as_ref().expect("details");
    assert_eq!(details["dialog"], "Save changes?");
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|s| s.contains("Save changes?"))
    );
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_window_on_another_desktop_gets_the_desktop_switched_before_the_request() {
    for send_fails in [false, true] {
        let mut world = World::new(Some(OTHER));
        world.desktop = DesktopPlacement::On(2);
        world.current_desktop = Some(0);
        world.send_fails = send_fails;
        let outcome = run(&world, &window(), budget());
        if send_fails {
            let error = outcome.expect_err("the activation send failed after the desktop changed");
            assert_refused(&error, "activation_not_sent");
            assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        } else {
            outcome.expect("granted after the switch");
        }
        assert_eq!(writes(&world), ["desktop 2", "send"]);
    }
}

#[test]
fn an_already_active_window_on_another_desktop_still_gets_the_switch() {
    let mut world = World::new(Some(CLIENT));
    world.desktop = DesktopPlacement::On(1);
    world.current_desktop = Some(0);
    run(&world, &window(), budget()).expect("granted");
    assert_eq!(writes(&world)[0], "desktop 1");
}

#[test]
fn a_window_on_the_current_sticky_or_unknown_desktop_gets_no_switch() {
    for (placement, current) in [
        (DesktopPlacement::On(0), Some(0)),
        (DesktopPlacement::Sticky, Some(0)),
        (DesktopPlacement::Unknown, Some(0)),
        (DesktopPlacement::On(3), None),
    ] {
        let mut world = World::new(Some(OTHER));
        world.desktop = placement;
        world.current_desktop = current;
        run(&world, &window(), budget()).expect("granted");
        assert_eq!(writes(&world), ["send"], "{placement:?} {current:?}");
    }
}

#[test]
fn a_stopped_application_is_refused_as_unresponsive_before_anything_is_read_or_sent() {
    let mut world = World::new(Some(OTHER));
    world.stopped = true;
    let error = failure(&world);
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert!(writes(&world).is_empty());
    assert_ne!(error.disposition, DeliverySemantics::delivered_verified());
}

#[test]
fn a_window_the_manager_hides_because_its_desktop_is_not_current_is_switched_to_not_lifted() {
    let mut world = World::new(Some(OTHER));
    world.desktop = DesktopPlacement::On(1);
    world.current_desktop = Some(0);
    world.flags.hidden = true;
    world.flags.mapped = false;
    run(&world, &window(), budget()).expect("granted after the switch");
    assert_eq!(writes(&world), ["desktop 1", "send"]);
}

#[test]
fn a_lease_spent_before_the_fallback_preserves_the_first_send() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::Never;
    world.untimed_grants = true;
    let deadline = Deadline::after(50).expect("a deadline builds");
    let error = run(&world, &window(), deadline).expect_err("the lease ran out");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn an_ignored_stamped_request_is_resent_after_the_first_look_not_after_the_whole_grace() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::Never;
    world.untimed_grants = true;
    let deadline = Deadline::after(10_000).expect("a deadline builds");
    let started = std::time::Instant::now();
    run(&world, &window(), deadline).expect("the unstamped request is honoured");
    assert!(
        started.elapsed() < std::time::Duration::from_millis(1_500),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(writes(&world), ["send", "send_untimed"]);
}

#[test]
fn a_display_that_already_names_the_window_is_waited_on_for_the_whole_grace() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    let deadline = Deadline::after(10_000).expect("a deadline builds");
    let started = std::time::Instant::now();
    let error = run(&world, &window(), deadline).expect_err("the frame never follows");
    assert!(started.elapsed() >= std::time::Duration::from_millis(5_900));
    assert_eq!(error.details.expect("details")["cause"], "frame_not_active");
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_modal_dialog_its_toolkit_never_reports_active_is_accepted_on_the_display_and_the_input_focus()
{
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.frame_modal = Some(true);
    world.input_focus = true;
    run(&world, &window(), budget()).expect("active on the display with the focus in it");
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_dialog_frame_its_toolkit_never_reports_active_is_accepted_on_the_display_and_the_input_focus()
{
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.frame_dialog = true;
    world.input_focus = true;
    run(&world, &window(), budget()).expect("active on the display with the focus in it");
    assert_eq!(writes(&world), ["send"]);
}

#[test]
fn a_dialog_frame_whose_input_focus_lies_elsewhere_is_still_refused() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.frame_dialog = true;
    world.input_focus = false;
    assert_refused(&failure(&world), "frame_not_active");
}

#[test]
fn a_modal_dialog_whose_input_focus_lies_elsewhere_is_still_refused() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.frame_modal = Some(true);
    world.input_focus = false;
    assert_refused(&failure(&world), "frame_not_active");
}

#[test]
fn a_frame_that_is_not_modal_keeps_the_strict_rule_whatever_the_input_focus() {
    let mut world = World::new(Some(OTHER));
    world.grant = Grant::OnlyOnX11;
    world.frame_modal = Some(false);
    world.input_focus = true;
    assert_refused(&failure(&world), "frame_not_active");
}
