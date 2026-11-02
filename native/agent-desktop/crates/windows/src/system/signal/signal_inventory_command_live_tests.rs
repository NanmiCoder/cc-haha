//! Windows-only: drives `agent_desktop_core::commands::wait::execute` end to
//! end through a forced mid-wait capture failure, proving the closed
//! retryable-error contract at the command layer rather than only at
//! `capture_signal_baseline_impl`'s own boundary (`signals_tests.rs`).
//! Registered as a child of `signal_inventory` so it can reach `force_race`,
//! the seam that manufactures the mid-walk identity race this file forces
//! onto exactly one poll.
//!
//! Both waits below narrow by `--window-id` rather than `--app`, so the
//! capture stays unfiltered (`SignalFilter::default()`, matching every
//! `capture_windows_and_apps` call the seam still reaches) while the match
//! itself stays pinned to this fixture's own window - no `resolve_app` call
//! is made, so these two are immune to the same-image-name hazard
//! `test_support::FIXTURE_APP_NAME_LOCK` exists for.
#![cfg(target_os = "windows")]

use agent_desktop_core::commands::wait::{self, WaitArgs, WaitModeArgs, WaitPredicateArgs};
use agent_desktop_core::{AppError, CommandContext, ErrorCode};

use super::force_race;
use crate::adapter::WindowsAdapter;
use crate::system::window::listing_retry::LISTING_RACE_ATTEMPTS;
use crate::tree::fixture::{HostedFixture, bootstrap};

const NO_TRANSITION_TIMEOUT_MS: u64 = 1_500;

fn event_args(event: &str, window_id: String, timeout_ms: u64) -> WaitArgs {
    WaitArgs {
        mode: WaitModeArgs {
            event: Some(event.to_string()),
            window_id: Some(window_id),
            ..WaitModeArgs::default()
        },
        predicate: WaitPredicateArgs {
            predicate: None,
            value: None,
            action: None,
            count: None,
        },
        timeout_ms,
        app: None,
    }
}

fn timeout_details(error: AppError) -> serde_json::Value {
    let AppError::Adapter(adapter_error) = error else {
        panic!("a timed-out wait must surface as an AdapterError, not another AppError variant");
    };
    assert_eq!(
        adapter_error.code,
        ErrorCode::Timeout,
        "a retried capture failure must still end in an ordinary wait timeout, never the \
         forced failure's own code - that is what proves the wait was not aborted"
    );
    let details = adapter_error
        .details
        .expect("the timeout envelope carries details");
    assert_eq!(
        details["predicate"], "event",
        "the timeout envelope must name which predicate it was waiting on: {details}"
    );
    details
}

/// The closed retryable-error contract is already proven directly against
/// `capture_signal_baseline_impl` in `signals_tests.rs`. What this test adds
/// is the property a caller actually depends on: the poll loop absorbs the
/// failure and keeps going, and the failure's evidence survives into the
/// envelope the caller receives.
#[test]
fn a_capture_failure_mid_wait_does_not_abort_and_surfaces_as_last_error_in_the_timeout_envelope() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("a steady fixture starts");
    let window_id = format!("w-{}", fixture.handle() as usize);
    let args = event_args("window-closed", window_id, NO_TRANSITION_TIMEOUT_MS);
    let adapter = WindowsAdapter::new();

    let outcome = force_race::with(LISTING_RACE_ATTEMPTS as usize, || {
        wait::execute(args, &adapter, &CommandContext::default())
    });

    let details = timeout_details(
        outcome.expect_err("no transition occurred, so the wait must time out, not abort"),
    );
    assert_eq!(details["kind"], "wait_timeout");
    let last_error = &details["last_error"];
    assert!(
        last_error.is_object(),
        "a capture failure absorbed mid-wait must leave its evidence as last_error: {details}"
    );
    assert_eq!(last_error["code"], "APP_UNRESPONSIVE");
    drop(fixture);
}

#[test]
fn the_timeout_envelope_carries_baseline_counts_once_a_baseline_was_captured() {
    bootstrap();
    let fixture = HostedFixture::spawn().expect("a steady fixture starts");
    let window_id = format!("w-{}", fixture.handle() as usize);
    let args = event_args("window-closed", window_id, NO_TRANSITION_TIMEOUT_MS);
    let adapter = WindowsAdapter::new();

    let details = timeout_details(
        wait::execute(args, &adapter, &CommandContext::default())
            .expect_err("no transition occurred, so the wait must time out"),
    );
    let counts = &details["baseline_counts"];
    assert!(
        counts.is_object(),
        "baseline_counts must be populated once a baseline was captured: {details}"
    );
    assert!(counts["windows"].is_number());
    assert!(counts["apps"].is_number());
    assert!(counts["surfaces"].is_number());
    drop(fixture);
}
