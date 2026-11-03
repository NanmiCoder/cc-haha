use agent_desktop_core::{DeliverySemantics, ErrorCode, RetryDisposition};

use super::super::Request;
use super::super::fake::{Fake, dialog, window};
use super::close;
use crate::system::process::liveness::Liveness;
use crate::system::x11::control::ControlRead;
use crate::system::x11::control::control_error::ControlError;

fn request() -> Request<'static> {
    Request {
        name: "Text Editor",
        pid: 42,
        instance: Some("t"),
        force: false,
    }
}

fn assert_no_signal(world: &Fake) {
    assert_eq!(world.count("term"), 0);
    assert_eq!(world.count("kill"), 0);
}

#[test]
fn a_request_to_every_window_then_an_exit_is_ok_without_a_signal() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), window(2), window(3)]);
    world.exits_on_close = true;
    close(&world, &request()).expect("closes");
    assert_eq!(world.count("close"), 3);
    assert_no_signal(&world);
}

#[test]
fn a_stopped_process_is_unresponsive_and_nothing_is_sent() {
    let world = Fake::new(Liveness::Stopped);
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(world.count("toplevels"), 0);
    assert_no_signal(&world);
}

#[test]
fn a_process_that_stops_before_the_requests_is_unresponsive() {
    let mut world = Fake::new(Liveness::Alive);
    world.state_after_toplevels = Some(Liveness::Stopped);
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(world.count("close"), 0);
}

#[test]
fn unconfirmed_close_sends_are_uncertain_even_when_fan_out_expires() {
    for expires in [false, true] {
        let mut world = Fake::new(Liveness::Alive);
        world.windows = ControlRead::Ready(vec![window(1), window(2)]);
        *world.closes.borrow_mut() = vec![Err(ControlError::SendFailed); 2];
        world.expire_after_closes = expires.then_some(1);
        let error = close(&world, &request()).expect_err("unconfirmed send");
        assert_eq!(
            error.code,
            if expires {
                ErrorCode::Timeout
            } else {
                ErrorCode::ActionFailed
            }
        );
        assert_eq!(error.disposition, DeliverySemantics::uncertain());
        assert_eq!(world.count("close"), if expires { 1 } else { 2 });
    }
}

#[test]
fn a_process_exit_after_an_unconfirmed_send_does_not_claim_no_delivery() {
    let mut world = Fake::new(Liveness::Alive);
    *world.closes.borrow_mut() = vec![Err(ControlError::SendFailed)];
    world.exits_on_failed_close = true;
    let error = close(&world, &request()).expect_err("the send remains unconfirmed");
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
}

#[test]
fn a_process_that_exited_while_the_route_was_unavailable_is_ok() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::NotX11;
    world.state_after_toplevels = Some(Liveness::Gone);
    close(&world, &request()).expect("it exited meanwhile");
}

#[test]
fn wayland_or_no_manager_is_not_supported_and_sends_nothing() {
    for route in [ControlRead::NotX11, ControlRead::NoManager] {
        let mut world = Fake::new(Liveness::Alive);
        world.windows = route;
        let error = close(&world, &request()).expect_err("no route");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(world.count("close"), 0);
    }
}

#[test]
fn an_unreachable_display_is_action_failed_not_delivered() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Unavailable;
    let error = close(&world, &request()).expect_err("fails");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_windowless_live_process_is_refused_with_the_resident_suggestion() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(Vec::new());
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert!(error.suggestion.expect("suggestion").contains("--force"));
}

#[test]
fn a_windowless_process_on_a_wayland_session_is_not_supported_with_its_cause() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(Vec::new());
    world.wayland = true;
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.details.expect("details")["cause"], "wayland_session");
    assert_eq!(world.count("close"), 0);
}

#[test]
fn a_wayland_session_with_no_xwayland_is_not_supported_with_its_cause() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::NotX11;
    world.wayland = true;
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.details.expect("details")["cause"], "wayland_session");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_wayland_session_with_no_x11_manager_keeps_the_wayland_cause() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::NoManager;
    world.wayland = true;
    let error = close(&world, &request()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.details.expect("details")["cause"], "wayland_session");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(world.count("close"), 0);
    assert_no_signal(&world);
}

#[test]
fn a_windowless_process_that_exited_on_a_wayland_session_is_ok() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(Vec::new());
    world.wayland = true;
    world.state_after_toplevels = Some(Liveness::Gone);
    close(&world, &request()).expect("it left meanwhile");
}

#[test]
fn an_open_dialog_is_reported_and_no_close_request_is_sent_to_anything() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), dialog(2)]);
    world.exits_on_close = true;
    let error = close(&world, &request()).expect_err("a prompt is open");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert_eq!(details["dialogs"], 1);
    assert_eq!(details["windows_remaining"], 1);
    assert_eq!(details["dialog"], "dialog 2");
    assert_eq!(world.count("close"), 0);
}

#[test]
fn a_dialog_that_opens_after_the_request_ends_the_wait_at_once_with_its_title() {
    let mut world = Fake::new(Liveness::Alive);
    world.dialog_after = Some(std::time::Duration::from_millis(100));
    let error = close(&world, &request()).expect_err("the save prompt appeared");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert_eq!(details["dialog"], "dialog 99");
    assert_eq!(world.count("close"), 1);
    assert!(
        world.clock.get() < std::time::Duration::from_secs(1),
        "the wait did not run to its budget: {:?}",
        world.clock.get()
    );
}

#[test]
fn a_dialog_drawn_inside_a_window_is_reported_and_no_close_request_is_sent() {
    let mut world = Fake::new(Liveness::Alive);
    world.nested_after = Some(std::time::Duration::ZERO);
    world.exits_on_close = true;
    let error = close(&world, &request()).expect_err("a prompt is open");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert_eq!(details["dialogs"], 1);
    assert_eq!(details["windows_remaining"], 1);
    assert_eq!(details["dialog"], "Save Changes?");
    assert_eq!(world.count("close"), 0);
}

#[test]
fn a_dialog_drawn_inside_a_window_after_the_request_ends_the_wait_at_once() {
    let mut world = Fake::new(Liveness::Alive);
    world.nested_after = Some(std::time::Duration::from_millis(100));
    let error = close(&world, &request()).expect_err("the save prompt appeared");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert_eq!(details["dialogs"], 1);
    assert_eq!(details["dialog"], "Save Changes?");
    assert_eq!(world.count("close"), 1);
    assert!(
        world.clock.get() < std::time::Duration::from_secs(1),
        "the wait did not run to its budget: {:?}",
        world.clock.get()
    );
}

#[test]
fn a_second_prompt_raised_by_the_same_request_is_counted_from_one_read() {
    let mut world = Fake::new(Liveness::Alive);
    world.dialog_after = Some(std::time::Duration::from_millis(100));
    world.second_dialog_after = Some(std::time::Duration::from_millis(125));
    let error = close(&world, &request()).expect_err("two save prompts opened");
    let details = error.details.expect("details");
    assert_eq!(details["cause"], "dialog_pending");
    assert_eq!(details["dialogs"], 2);
    assert_eq!(details["dialog_titles"].as_array().map(Vec::len), Some(2));
    assert_eq!(details["windows_remaining"], 1);
    assert!(
        error.message.contains("2 open dialog(s)"),
        "{}",
        error.message
    );
}

#[test]
fn a_prompt_answered_while_the_result_settles_is_an_exit_not_a_refusal() {
    let mut world = Fake::new(Liveness::Alive);
    world.dialog_after = Some(std::time::Duration::from_millis(100));
    world.gone_after = Some(std::time::Duration::from_millis(125));
    assert!(close(&world, &request()).expect("it left meanwhile"));
}

#[test]
fn a_process_that_left_while_a_dialog_was_read_is_ok() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), dialog(2)]);
    world.state_after_toplevels = Some(Liveness::Gone);
    close(&world, &request()).expect("it left meanwhile");
}

#[test]
fn one_failing_send_does_not_stop_the_others() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), window(2), window(3)]);
    *world.closes.borrow_mut() = vec![Err(ControlError::SendFailed)];
    world.exits_on_close = true;
    close(&world, &request()).expect("the other two closed the app");
    assert_eq!(world.count("close"), 3);
}

#[test]
fn a_window_that_vanished_is_not_a_failed_send() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), window(2)]);
    *world.closes.borrow_mut() = vec![Err(ControlError::BadWindow)];
    world.exits_on_close = true;
    close(&world, &request()).expect("the second window closed the app");
}

#[test]
fn a_stale_close_target_refuses_further_sends_and_preserves_prior_delivery() {
    for sent_first in [false, true] {
        let mut world = Fake::new(Liveness::Alive);
        world.windows = ControlRead::Ready(vec![window(1), window(2), window(3)]);
        let mut results = world.closes.borrow_mut();
        if sent_first {
            results.push(Ok(()));
        }
        results.push(Err(ControlError::StaleWindow));
        drop(results);
        let error = close(&world, &request()).expect_err("the owner changed");
        assert_eq!(error.code, ErrorCode::StaleRef);
        assert_eq!(
            error.disposition,
            if sent_first {
                DeliverySemantics::delivered_unverified()
            } else {
                DeliverySemantics::not_delivered()
            }
        );
        assert_eq!(world.count("close"), if sent_first { 2 } else { 1 });
        assert_no_signal(&world);
    }
}

#[test]
fn a_deadline_in_the_middle_of_the_fan_out_is_a_timeout_not_a_failed_send() {
    let mut world = Fake::new(Liveness::Alive);
    world.windows = ControlRead::Ready(vec![window(1), window(2), window(3)]);
    world.expire_after_closes = Some(1);
    let error = close(&world, &request()).expect_err("times out");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(world.count("close"), 1);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_deadline_before_the_first_send_is_a_timeout_that_was_not_delivered() {
    let mut world = Fake::new(Liveness::Alive);
    world.expire_after_closes = Some(0);
    let error = close(&world, &request()).expect_err("times out");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_graceful_timeout_is_the_envelope_macos_and_windows_pin() {
    let mut world = Fake::new(Liveness::Alive);
    world.late = ControlRead::Ready(vec![window(1), dialog(2)]);
    let error = close(&world, &request()).expect_err("the app stays");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(error.disposition.retry(), RetryDisposition::Unsafe);
    assert_no_signal(&world);
    let details = error.details.expect("details");
    assert_eq!(details["windows_remaining"], 1);
    assert_eq!(details["dialogs"], 1);
    assert!(error.suggestion.expect("suggestion").contains("prompt"));
}

#[test]
fn a_timeout_with_no_window_and_no_dialog_names_the_resident_app() {
    let world = Fake::new(Liveness::Alive);
    let error = close(&world, &request()).expect_err("the app stays");
    assert_eq!(error.code, ErrorCode::Timeout);
    let suggestion = error.suggestion.expect("suggestion");
    assert!(suggestion.contains("no open window"), "{suggestion}");
    assert!(!suggestion.contains("prompt"), "{suggestion}");
}

#[test]
fn the_wait_ends_as_soon_as_the_process_is_gone() {
    let mut world = Fake::new(Liveness::Alive);
    world.exits_on_close = true;
    close(&world, &request()).expect("closes");
    assert!(world.clock.get().is_zero());
}
