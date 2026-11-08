use agent_desktop_core::{AppInfo, DeliverySemantics, ErrorCode, ProcessId};

use super::fake::{Fake, facts};
use super::{Request, run};
use crate::system::process::liveness::Liveness;

fn app() -> AppInfo {
    AppInfo {
        name: "Calculator".to_owned(),
        pid: ProcessId::new(42),
        bundle_id: None,
        process_instance: Some("t".to_owned()),
        presentation: None,
    }
}

fn request(force: bool) -> Request<'static> {
    Request {
        name: "Calculator",
        pid: 42,
        instance: Some("t"),
        force,
    }
}

#[test]
fn session_ownership_refuses_close_before_any_send_regardless_of_names() {
    for force in [false, true] {
        let mut world = Fake::new(Liveness::Alive);
        world.protected = Ok(true);
        world.facts = facts("arbitrary");
        let error = run(&world, &request(force)).expect_err("refused");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        for sent in ["toplevels", "close", "term", "kill"] {
            assert_eq!(world.count(sent), 0);
        }
    }
}

#[test]
fn unreadable_ownership_refuses_close_without_delivery() {
    for force in [false, true] {
        let mut world = Fake::new(Liveness::Alive);
        world.protected = Err(agent_desktop_core::AdapterError::not_supported(
            "session ownership",
        ));
        let error = run(&world, &request(force)).expect_err("refused");
        assert_eq!(error.code, ErrorCode::PlatformNotSupported);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        for sent in ["toplevels", "close", "term", "kill"] {
            assert_eq!(world.count(sent), 0, "{sent} force={force}");
        }
    }
}

#[test]
fn a_process_whose_facts_cannot_be_read_is_not_closed() {
    let mut world = Fake::new(Liveness::Alive);
    world.facts = crate::system::process::process_lookup::Lookup::Unreadable;
    let error = run(&world, &request(true)).expect_err("refused");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(world.count("term"), 0);
}

#[test]
fn a_missing_token_is_invalid_args_and_sends_nothing() {
    for force in [false, true] {
        let world = Fake::new(Liveness::Alive);
        let tokenless = Request {
            instance: None,
            ..request(force)
        };
        let error = run(&world, &tokenless).expect_err("refused");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        for sent in ["toplevels", "close", "term", "kill"] {
            assert_eq!(world.count(sent), 0, "{sent} force={force}");
        }
    }
}

#[test]
fn a_changed_token_is_a_benign_ok_that_signals_nothing() {
    for force in [false, true] {
        let world = Fake::new(Liveness::Gone);
        run(&world, &request(force)).expect("benign");
        for sent in ["toplevels", "close", "term", "kill"] {
            assert_eq!(world.count(sent), 0, "{sent} force={force}");
        }
    }
}

#[test]
fn a_process_gone_before_any_close_request_is_reported_as_already_gone() {
    let mut world = Fake::new(Liveness::Alive);
    world.state_after_toplevels = Some(Liveness::Gone);

    let report = super::run_report(&world, &app(), false).expect("benign race");

    assert_eq!(report.disposition(), DeliverySemantics::not_delivered());
    assert!(report.result.steps.is_empty());
    assert_eq!(world.count("close"), 0);
}

#[test]
fn a_force_signal_that_finds_a_gone_or_replaced_process_reports_no_delivery() {
    for outcome in [
        crate::system::signal::signal_sent::Sent::AlreadyGone,
        crate::system::signal::signal_sent::Sent::Replaced,
    ] {
        let world = Fake::new(Liveness::Alive);
        world.signal_outcomes.borrow_mut().push(Ok(outcome));

        let report = super::run_report(&world, &app(), true).expect("benign race");

        assert_eq!(report.disposition(), DeliverySemantics::not_delivered());
        assert!(report.result.steps.is_empty());
        assert_eq!(world.count("term"), 1);
        assert_eq!(world.count("kill"), 0);
    }
}

#[test]
fn a_close_request_that_exits_the_process_is_reported_as_verified() {
    let mut world = Fake::new(Liveness::Alive);
    world.exits_on_close = true;

    let report = super::run_report(&world, &app(), false).expect("closed");

    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(world.count("close"), 1);
}

#[test]
fn an_error_after_a_close_request_keeps_target_and_unverified_step_evidence() {
    let mut world = Fake::new(Liveness::Alive);
    world.dialog_after = Some(std::time::Duration::from_millis(100));

    let error = super::run_report(&world, &app(), false).expect_err("dialog blocks exit");

    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("dispatch evidence");
    assert_eq!(details["target"]["kind"], "app");
    assert_eq!(details["steps"][0]["label"], "terminate_request");
    assert_eq!(details["steps"][0]["verified"], false);
}

#[test]
fn failed_close_sends_name_the_target_without_claiming_a_completed_step() {
    let world = Fake::new(Liveness::Alive);
    *world.closes.borrow_mut() = vec![Err(
        crate::system::x11::control::control_error::ControlError::SendFailed,
    )];

    let error = super::run_report(&world, &app(), false).expect_err("request failed");

    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    let details = error.details.expect("target evidence");
    assert_eq!(details["target"]["kind"], "app");
    assert!(details.get("steps").is_none());
}

#[test]
fn a_term_sent_before_the_process_is_replaced_remains_a_delivered_close() {
    let world = Fake::new(Liveness::Alive);
    *world.signal_outcomes.borrow_mut() = vec![
        Ok(crate::system::signal::signal_sent::Sent::Delivered),
        Ok(crate::system::signal::signal_sent::Sent::Replaced),
    ];

    let report = super::run_report(&world, &app(), true).expect("term was delivered");

    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(world.count("term"), 1);
    assert_eq!(world.count("kill"), 1);
}
