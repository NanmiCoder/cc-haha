//! A ref action against a killed owning process must answer terminally on
//! the first resolution attempt, not burn the whole retry budget to a bare
//! `TIMEOUT`. Measured before the fix: ~5s at the default deadline (~1.1s at
//! `--timeout-ms 1000`), `recovery: null` - `stale_ref_error`'s
//! `retryable: default_retryable` always reads `true` off an
//! `Unspecified`-retryability base, so core's poll loop kept re-invoking
//! resolution to the outer deadline.

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode, ProcessId, RefEntry};

use crate::tree::fixture::{HostedFixture, ensure_test_apartment};
use crate::tree::resolve::resolve_element_strict;

fn entry_for(fixture: &HostedFixture, token: String, window_handle: isize) -> RefEntry {
    let mut entry = crate::tree::walk::walker_fake::ref_entry("button");
    entry.process = agent_desktop_core::RefProcess {
        pid: ProcessId::from(fixture.process_id()),
        process_instance: Some(token),
    };
    entry.identity.name = Some("OK".into());
    entry.source.source_app = Some("fixture.exe".into());
    entry.source.source_window_id = Some(format!("w-{window_handle}"));
    entry
}

fn dead_process_entry(fixture: &HostedFixture, token: String) -> RefEntry {
    entry_for(fixture, token, fixture.handle())
}

fn token_for(fixture: &HostedFixture) -> String {
    crate::system::process_identity::token_for_pid(ProcessId::from(fixture.process_id()))
        .unwrap()
        .expect("a live fixture process has a token")
}

/// The dead-owner path: kill and wait for the fixture host, then resolve
/// against a generous deadline. A live process recreating its window
/// mid-redraw must stay retryable, so this only proves the *terminal* half -
/// the still-alive-or-unreadable fallback is exercised by every other
/// resolver test in this module that never kills the fixture.
#[test]
fn a_dead_owning_process_settles_terminally_on_the_first_attempt() {
    ensure_test_apartment();
    let mut fixture = HostedFixture::spawn().expect("a fixture host starts");
    let token = token_for(&fixture);
    let entry = dead_process_entry(&fixture, token);

    fixture.terminate();

    let deadline = Deadline::after(5_000).expect("a deadline");
    let started = std::time::Instant::now();
    let result = resolve_element_strict(&entry, deadline);
    let elapsed = started.elapsed();

    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("a dead owning process must never resolve to a live element"),
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let details = error
        .details
        .clone()
        .expect("the terminal diagnosis carries details");
    assert_eq!(details["kind"], "resolve_owning_process_exited");
    assert_eq!(details["retryable"], false);
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "a terminal verdict must settle on the first attempt, not burn the \
         5s deadline retrying a process that is already gone - elapsed was {elapsed:?}"
    );
}

/// The no-over-reach guard: `verify_stored()` can fail for a reason that has
/// nothing to do with the owning process being gone - here, the stored
/// window id now names a handle a different, still-alive process owns (the
/// mid-redraw-recreation shape `resolve_window_root`'s doc comment already
/// names). The stored identity (fixture A) is alive throughout, so the
/// classification must fall through to today's `stale_ref_error` - the same
/// `resolve_no_candidate` kind, still retryable - never the terminal one.
#[test]
fn a_live_owner_with_a_reassigned_handle_stays_on_the_retryable_path() {
    ensure_test_apartment();
    let fixture_a = HostedFixture::spawn().expect("fixture A starts");
    let fixture_b = HostedFixture::spawn().expect("fixture B starts");
    let token_a = token_for(&fixture_a);
    let entry = entry_for(&fixture_a, token_a, fixture_b.handle());

    let deadline = Deadline::after(5_000).expect("a deadline");
    let result = resolve_element_strict(&entry, deadline);

    let error = match result {
        Err(error) => error,
        Ok(_) => {
            panic!("a stored window whose handle a different process now owns must not resolve")
        }
    };

    assert_eq!(error.code, ErrorCode::StaleRef);
    let details = error
        .details
        .clone()
        .expect("the resolver's own diagnosis carries details");
    assert_eq!(details["kind"], "resolve_no_candidate");
    assert_ne!(details["kind"], "resolve_owning_process_exited");
    assert_eq!(details["retryable"], true);
}
