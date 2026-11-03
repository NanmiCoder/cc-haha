use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::*;

const TOKEN: &str = "adtoken1";

struct FakePending {
    answer: Rc<RefCell<Option<Result<PortalAnswer, AdapterError>>>>,
    cancelled: Rc<Cell<u32>>,
}

impl Pending for FakePending {
    fn cancel(self: Box<Self>) {
        self.cancelled.set(self.cancelled.get() + 1);
    }

    fn wait(self: Box<Self>, _deadline: Deadline) -> Result<PortalAnswer, AdapterError> {
        self.answer
            .borrow_mut()
            .take()
            .expect("a response was delivered before the wait")
    }
}

struct FakeWire {
    events: RefCell<Vec<String>>,
    answer: Rc<RefCell<Option<Result<PortalAnswer, AdapterError>>>>,
    early: Option<Result<PortalAnswer, AdapterError>>,
    handle: Option<String>,
    unique: String,
    cancelled: Rc<Cell<u32>>,
    call_error: Option<AdapterError>,
}

impl FakeWire {
    fn answering(answer: Result<PortalAnswer, AdapterError>) -> Self {
        Self {
            events: RefCell::new(Vec::new()),
            answer: Rc::new(RefCell::new(None)),
            early: Some(answer),
            handle: None,
            unique: ":1.42".into(),
            cancelled: Rc::new(Cell::new(0)),
            call_error: None,
        }
    }
}

impl PortalWire for FakeWire {
    fn unique_name(&self) -> String {
        self.unique.clone()
    }

    fn subscribe(
        &self,
        request_path: &str,
        _deadline: Deadline,
    ) -> Result<Box<dyn Pending>, AdapterError> {
        self.events
            .borrow_mut()
            .push(format!("subscribe {request_path}"));
        Ok(Box::new(FakePending {
            answer: Rc::clone(&self.answer),
            cancelled: Rc::clone(&self.cancelled),
        }))
    }

    fn call_screenshot(&self, token: &str, _deadline: Deadline) -> Result<String, AdapterError> {
        self.events.borrow_mut().push(format!("call {token}"));
        if let Some(error) = &self.call_error {
            return Err(error.clone());
        }
        *self.answer.borrow_mut() = self.early.clone();
        Ok(self
            .handle
            .clone()
            .unwrap_or_else(|| request_path(&self.unique, token)))
    }
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a deadline")
}

fn granted(uri: &str) -> Result<PortalAnswer, AdapterError> {
    Ok(PortalAnswer::Granted {
        uri: Some(uri.into()),
    })
}

#[test]
fn the_request_path_follows_the_portal_naming() {
    assert_eq!(
        request_path(":1.42", TOKEN),
        "/org/freedesktop/portal/desktop/request/1_42/adtoken1"
    );
}

#[test]
fn response_two_does_not_send_the_caller_only_to_the_privacy_settings() {
    let wire = FakeWire::answering(Ok(PortalAnswer::Refused { code: 2 }));
    let error = screenshot_uri(&wire, TOKEN, deadline()).expect_err("ended");
    let hint = error.suggestion.expect("a hint");
    assert!(hint.contains("dialog left open"), "{hint}");
    assert!(hint.contains("25 seconds"), "{hint}");
    assert!(hint.contains("backend"), "{hint}");
    assert!(
        error.message.contains("without a result"),
        "{}",
        error.message
    );
    let one = FakeWire::answering(Ok(PortalAnswer::Refused { code: 1 }));
    let refusal = screenshot_uri(&one, TOKEN, deadline()).expect_err("refused");
    assert!(
        !refusal
            .suggestion
            .expect("a hint")
            .contains("dialog left open")
    );
}

#[test]
fn a_failed_call_closes_the_request_it_may_have_opened() {
    let mut wire = FakeWire::answering(granted("file:///tmp/x.png"));
    wire.call_error = Some(AdapterError::timeout("slow"));
    let error = screenshot_uri(&wire, TOKEN, deadline()).expect_err("slow call");
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(wire.cancelled.get(), 1);
}

#[test]
fn a_grant_without_a_file_is_an_action_failure() {
    let wire = FakeWire::answering(Ok(PortalAnswer::Granted { uri: None }));
    let error = screenshot_uri(&wire, TOKEN, deadline()).expect_err("no file");
    assert_eq!(error.code, ErrorCode::ActionFailed);
}

#[test]
fn the_subscription_precedes_the_call_so_an_early_response_is_seen() {
    let wire = FakeWire::answering(granted("file:///tmp/early.png"));
    assert_eq!(
        screenshot_uri(&wire, TOKEN, deadline()).expect("the early response is kept"),
        "file:///tmp/early.png"
    );
    let events = wire.events.borrow();
    assert_eq!(events.len(), 2);
    assert!(events[0].starts_with("subscribe "), "{events:?}");
    assert!(events[1].starts_with("call "), "{events:?}");
}

#[test]
fn a_handle_that_is_not_the_subscribed_path_is_refused() {
    let mut wire = FakeWire::answering(granted("file:///tmp/x.png"));
    wire.handle = Some("/org/freedesktop/portal/desktop/request/1_42/other".into());
    let error = screenshot_uri(&wire, TOKEN, deadline()).expect_err("a mismatch");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(wire.cancelled.get(), 1);
}

#[test]
fn unanswered_portal_consent_requires_dialog_resolution_before_another_capture() {
    let wire = FakeWire::answering(Err(AdapterError::timeout("late")));
    let mut call_timeout = FakeWire::answering(granted("file:///tmp/x.png"));
    call_timeout.call_error = Some(AdapterError::timeout("call timed out"));
    for error in [
        screenshot_uri(&wire, TOKEN, deadline()).unwrap_err(),
        screenshot_uri(&call_timeout, TOKEN, deadline()).unwrap_err(),
        refused(2, PORTAL_PATIENCE),
    ] {
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::uncertain()
        );
        assert!(!error.permits_retry_by_default());
        let payload = agent_desktop_core::ErrorPayload::from_app_error(&error.into());
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["disposition"]["retry"], "unsafe");
        assert_eq!(json["details"]["dialog_may_be_open"], true);
        assert!(json.get("recovery").is_none());
        let hint = json["suggestion"].as_str().unwrap();
        assert!(hint.contains("answer or dismiss"), "{hint}");
        assert!(hint.contains("wait until it closes"), "{hint}");
    }
}

#[test]
fn response_two_after_the_portal_patience_is_a_timeout_not_a_refusal() {
    let error = refused(2, PORTAL_PATIENCE);
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("dialog"))
    );
    let error = refused(2, Duration::ZERO);
    assert_eq!(error.code, ErrorCode::PermDenied);
}

#[test]
fn response_one_never_reads_as_a_timeout_and_names_deny_and_dismissal() {
    let error = refused(1, PORTAL_PATIENCE);
    assert_eq!(error.code, ErrorCode::PermDenied);
    let hint = error.suggestion.expect("a hint");
    assert!(hint.contains("chose Deny or closed"), "{hint}");
    assert!(hint.contains("if a Deny was remembered"), "{hint}");
}
