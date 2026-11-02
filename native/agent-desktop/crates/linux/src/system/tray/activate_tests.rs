use std::cell::RefCell;

use agent_desktop_core::{Action, ActionRequest, AdapterError, DeliveryDisposition, ErrorCode};

use super::*;

#[derive(Default)]
struct Wire {
    present: bool,
    sent: RefCell<Vec<String>>,
}

impl ItemWire for Wire {
    fn owner_present(&self) -> Result<bool, AdapterError> {
        Ok(self.present)
    }

    fn send(&self, method: &str) -> Result<(), AdapterError> {
        self.sent.borrow_mut().push(method.to_owned());
        Ok(())
    }
}

fn methods(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn run_with(
    methods: &[String],
    request: ActionRequest,
    wire: &Wire,
) -> Result<agent_desktop_core::ActionResult, AdapterError> {
    let item = Item {
        title: "Dropbox",
        methods,
        request: &request,
    };
    run(&item, wire)
}

fn present() -> Wire {
    Wire {
        present: true,
        ..Wire::default()
    }
}

#[test]
fn a_listed_activate_is_sent_for_a_click_even_when_headed() {
    for request in [
        ActionRequest::headless(Action::Click),
        ActionRequest::headed(Action::Click),
    ] {
        let wire = present();
        run_with(&methods(&["Activate", "SecondaryActivate"]), request, &wire).expect("delivered");
        assert_eq!(*wire.sent.borrow(), ["Activate"]);
    }
}

#[test]
fn a_headless_click_with_no_activate_is_refused_and_nothing_is_sent() {
    for listed in [
        methods(&[]),
        methods(&["SecondaryActivate"]),
        methods(&["XAyatanaSecondaryActivate"]),
        methods(&["SecondaryActivate", "XAyatanaSecondaryActivate", "Scroll"]),
    ] {
        let wire = present();
        let error =
            run_with(&listed, ActionRequest::headless(Action::Click), &wire).expect_err("refused");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert_eq!(
            error.details.expect("details")["physical_delivery_started"],
            false
        );
        assert!(error.suggestion.expect("suggestion").contains("menu entry"));
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
        assert!(wire.sent.borrow().is_empty());
    }
}

#[test]
fn a_headed_click_with_no_activate_refuses_an_unproven_native_receiver() {
    let wire = present();
    run_with(
        &methods(&["SecondaryActivate"]),
        ActionRequest::headed(Action::Click),
        &wire,
    )
    .expect_err("a label match cannot prove an SNI pointer receiver");
    assert!(wire.sent.borrow().is_empty());
}

#[test]
fn right_click_requires_the_advertised_context_method() {
    let wire = present();
    run_with(
        &methods(&[
            "ContextMenu",
            "SecondaryActivate",
            "XAyatanaSecondaryActivate",
        ]),
        ActionRequest::headless(Action::RightClick),
        &wire,
    )
    .expect("delivered");
    assert_eq!(*wire.sent.borrow(), ["ContextMenu"]);

    for request in [
        ActionRequest::headed(Action::RightClick),
        ActionRequest::headless(Action::RightClick),
    ] {
        let wire = present();
        let error = run_with(&methods(&[]), request, &wire).expect_err("no context method");
        assert_eq!(error.code, ErrorCode::ActionNotSupported);
        assert!(error.message.contains("lists no ContextMenu method"));
        assert_eq!(
            error.disposition.delivery(),
            DeliveryDisposition::NotDelivered
        );
        assert!(wire.sent.borrow().is_empty());
    }
}

#[test]
fn a_missing_owner_fails_closed_before_any_call() {
    let wire = Wire::default();
    let error = run_with(
        &methods(&["Activate"]),
        ActionRequest::headless(Action::Click),
        &wire,
    )
    .expect_err("owner gone");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert!(wire.sent.borrow().is_empty());
}

#[test]
fn a_delivered_activate_is_reported_unverified() {
    let wire = present();
    let result = run_with(
        &methods(&["Activate"]),
        ActionRequest::headless(Action::Click),
        &wire,
    )
    .expect("delivered");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredUnverified
    );
}

#[test]
fn an_action_other_than_click_is_not_supported_on_an_item() {
    let wire = present();
    let error = run_with(
        &methods(&["Activate"]),
        ActionRequest::headless(Action::Toggle),
        &wire,
    )
    .expect_err("unsupported");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(wire.sent.borrow().is_empty());
}
