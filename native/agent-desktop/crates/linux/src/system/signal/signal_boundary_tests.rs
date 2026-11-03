use std::cell::Cell;
use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::json;

use super::{Scope, narrow};

fn successor(code: &ErrorCode) -> Option<ErrorCode> {
    match code {
        ErrorCode::PermDenied => Some(ErrorCode::ElementNotFound),
        ErrorCode::ElementNotFound => Some(ErrorCode::AppNotFound),
        ErrorCode::AppNotFound => Some(ErrorCode::ActionFailed),
        ErrorCode::ActionFailed => Some(ErrorCode::ActionNotSupported),
        ErrorCode::ActionNotSupported => Some(ErrorCode::StaleRef),
        ErrorCode::StaleRef => Some(ErrorCode::AmbiguousTarget),
        ErrorCode::AmbiguousTarget => Some(ErrorCode::WindowNotFound),
        ErrorCode::WindowNotFound => Some(ErrorCode::PlatformNotSupported),
        ErrorCode::PlatformNotSupported => Some(ErrorCode::Timeout),
        ErrorCode::Timeout => Some(ErrorCode::InvalidArgs),
        ErrorCode::InvalidArgs => Some(ErrorCode::NotificationNotFound),
        ErrorCode::NotificationNotFound => Some(ErrorCode::SnapshotNotFound),
        ErrorCode::SnapshotNotFound => Some(ErrorCode::PolicyDenied),
        ErrorCode::PolicyDenied => Some(ErrorCode::AppUnresponsive),
        ErrorCode::AppUnresponsive => Some(ErrorCode::Internal),
        ErrorCode::Internal => None,
    }
}

fn every_code() -> Vec<ErrorCode> {
    let mut codes = vec![ErrorCode::PermDenied];
    while let Some(next) = codes.last().and_then(successor) {
        codes.push(next);
    }
    codes
}

fn live() -> Deadline {
    Deadline::after(5_000).expect("deadline")
}

fn spent() -> Deadline {
    let deadline = Deadline::after(1).expect("deadline");
    std::thread::sleep(Duration::from_millis(5));
    deadline
}

fn bus_unavailable() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "The AT-SPI accessibility bus is not available in this session",
    )
    .with_details(json!({ "retryable": false }))
}

fn stopped() -> AdapterError {
    AdapterError::app_unresponsive("calc")
        .with_details(json!({ "pid": 7, "process_instance": "boot:7" }))
}

fn run(error: AdapterError, scope: Scope, deadline: Deadline) -> (AdapterError, u32) {
    let forgotten = Cell::new(0);
    let narrowed = narrow(error, scope, deadline, || {
        forgotten.set(forgotten.get() + 1)
    });
    (narrowed, forgotten.get())
}

#[test]
fn an_internal_fault_becomes_a_timeout_and_forgets_the_connection_once() {
    let fault = AdapterError::internal("decoder fell over").with_platform_detail("zbus: broken");
    let (narrowed, forgotten) = run(fault, Scope::Scoped, live());
    assert_eq!(narrowed.code, ErrorCode::Timeout);
    assert_eq!(forgotten, 1);
    assert!(
        narrowed
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("zbus: broken"))
    );
}

#[test]
fn a_spent_deadline_keeps_the_forget_for_an_internal_fault() {
    let (narrowed, forgotten) = run(AdapterError::internal("x"), Scope::Unscoped, spent());
    assert_eq!(narrowed.code, ErrorCode::Timeout);
    assert_eq!(forgotten, 1);
}

#[test]
fn a_timeout_passes_without_forgetting() {
    let (narrowed, forgotten) = run(AdapterError::timeout("slow"), Scope::Scoped, live());
    assert_eq!(narrowed.code, ErrorCode::Timeout);
    assert_eq!(forgotten, 0);
}

#[test]
fn a_scoped_stopped_target_stays_unresponsive_with_its_identity() {
    let (narrowed, forgotten) = run(stopped(), Scope::Scoped, live());
    assert_eq!(narrowed.code, ErrorCode::AppUnresponsive);
    assert_eq!(forgotten, 0);
    let details = narrowed.details.expect("details");
    assert_eq!(details["pid"], 7);
    assert_eq!(details["process_instance"], "boot:7");
}

#[test]
fn an_unscoped_unresponsive_error_is_a_timeout() {
    let (narrowed, _) = run(stopped(), Scope::Unscoped, live());
    assert_eq!(narrowed.code, ErrorCode::Timeout);
}

#[test]
fn a_spent_deadline_is_a_timeout_whatever_failed() {
    for code in [
        ErrorCode::WindowNotFound,
        ErrorCode::Internal,
        ErrorCode::Timeout,
    ] {
        let (narrowed, _) = run(AdapterError::new(code, "x"), Scope::Scoped, spent());
        assert_eq!(narrowed.code, ErrorCode::Timeout);
        assert_eq!(narrowed.details.expect("details")["kind"], "deadline");
    }
}

#[test]
fn a_missing_bus_stays_fatal_and_never_forgets() {
    for scope in [Scope::Scoped, Scope::Unscoped] {
        let (narrowed, forgotten) = run(bus_unavailable(), scope, live());
        assert_eq!(narrowed.code, ErrorCode::PlatformNotSupported);
        assert_eq!(forgotten, 0);
    }
}

#[test]
fn a_plain_not_supported_answer_is_not_the_missing_bus() {
    let (narrowed, _) = run(
        AdapterError::not_supported("capture_signal_baseline"),
        Scope::Scoped,
        live(),
    );
    assert_eq!(narrowed.code, ErrorCode::Timeout);
}

#[test]
fn no_output_code_lies_outside_the_three() {
    for scope in [Scope::Scoped, Scope::Unscoped] {
        for code in every_code() {
            let (narrowed, _) = run(AdapterError::new(code.clone(), "x"), scope, live());
            let allowed = matches!(
                narrowed.code,
                ErrorCode::Timeout | ErrorCode::AppUnresponsive | ErrorCode::PlatformNotSupported
            );
            assert!(allowed, "{code:?} became {:?}", narrowed.code);
        }
    }
}
