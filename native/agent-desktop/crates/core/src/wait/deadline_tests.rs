use std::time::Duration;

use super::{VirtualClock, now, sleep};
use crate::{Deadline, ErrorCode};

#[test]
fn oversized_deadline_is_rejected() {
    assert_eq!(
        Deadline::after(u64::MAX).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
}

#[test]
fn slices_never_extend_the_parent_budget() {
    let deadline = Deadline::after(100).unwrap();
    assert!(
        deadline.remaining_slice(Duration::from_secs(1)).unwrap() <= Duration::from_millis(100)
    );
}

#[test]
fn inherited_deadline_caps_longer_local_budget() {
    let inherited = Deadline::after(25).unwrap();
    let _scope = super::enter_scope(Some(inherited));
    let local = Deadline::after(5_000).unwrap();

    assert!(local.remaining() <= Duration::from_millis(25));
}

#[test]
fn shorter_local_budget_wins_inside_inherited_scope() {
    let inherited = Deadline::after(5_000).unwrap();
    let _scope = super::enter_scope(Some(inherited));
    let local = Deadline::after(20).unwrap();

    assert!(local.remaining() <= Duration::from_millis(20));
}

#[test]
fn detached_recovery_budget_survives_an_expired_inherited_scope() {
    let inherited = Deadline::after(0).unwrap();
    let _scope = super::enter_scope(Some(inherited));

    let cleanup = Deadline::detached_after(100).unwrap();

    assert!(!cleanup.is_expired());
    assert!(cleanup.remaining() > Duration::from_millis(50));
}

#[test]
fn extension_moves_the_expiry_and_keeps_the_timeout() {
    let deadline = Deadline::after(1_000).unwrap();

    let extended = deadline.extended_by(Duration::from_millis(500));

    let longer = extended.remaining();
    assert!(longer >= deadline.remaining() + Duration::from_millis(500));
    assert_eq!(extended.timeout_ms(), 1_000);
}

#[test]
fn extension_stays_inside_an_inherited_deadline() {
    let inherited = Deadline::after(25).unwrap();
    let _scope = super::enter_scope(Some(inherited));
    let local = Deadline::after(20).unwrap();

    let extended = local.extended_by(Duration::from_secs(5));

    assert!(extended.remaining() <= Duration::from_millis(25));
}

#[test]
fn ensure_remaining_passes_while_the_deadline_is_live() {
    let deadline = Deadline::after(5_000).unwrap();

    assert!(deadline.ensure_remaining().is_ok());
}

#[test]
fn ensure_remaining_fails_with_the_timeout_error_once_expired() {
    let deadline = Deadline::after(0).unwrap();
    let expected = deadline.timeout_error();

    let error = deadline.ensure_remaining().unwrap_err();

    assert_eq!(error.code, expected.code);
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.message, expected.message);
    let without_elapsed = |error: &crate::AdapterError| {
        let mut details = error.details.clone().unwrap();
        details.as_object_mut().unwrap().remove("elapsed_ms");
        details
    };
    assert_eq!(without_elapsed(&error), without_elapsed(&expected));
}

#[test]
fn a_frozen_clock_expires_a_deadline_only_when_advanced() {
    let clock = VirtualClock::freeze();
    let deadline = Deadline::after(100).unwrap();

    assert!(!deadline.is_expired());
    assert_eq!(deadline.remaining(), Duration::from_millis(100));

    clock.advance(Duration::from_millis(99));
    assert!(!deadline.is_expired());
    assert_eq!(deadline.remaining(), Duration::from_millis(1));

    clock.advance(Duration::from_millis(1));
    assert!(deadline.is_expired());
    assert_eq!(deadline.elapsed(), Duration::from_millis(100));
    assert_eq!(clock.elapsed(), Duration::from_millis(100));
}

#[test]
fn virtual_sleep_advances_the_clock_without_blocking() {
    let clock = VirtualClock::freeze();
    let deadline = Deadline::after(10_000).unwrap();

    sleep(Duration::from_secs(5));

    assert_eq!(clock.elapsed(), Duration::from_secs(5));
    assert_eq!(deadline.remaining(), Duration::from_secs(5));
    assert_eq!(deadline.elapsed(), Duration::from_secs(5));
}

#[test]
fn a_cap_expires_exactly_at_its_slice() {
    let clock = VirtualClock::freeze();
    let capped = Deadline::after(1_000)
        .unwrap()
        .capped(Duration::from_millis(30));

    assert!(capped.was_capped());
    clock.advance(Duration::from_millis(29));
    assert!(!capped.is_expired());
    clock.advance(Duration::from_millis(1));
    assert!(capped.is_expired());
}

#[test]
fn a_cap_longer_than_the_budget_leaves_it_unchanged() {
    let clock = VirtualClock::freeze();
    let deadline = Deadline::after(100).unwrap();
    let capped = deadline.capped(Duration::from_secs(60));

    assert!(!capped.was_capped());
    clock.advance(Duration::from_millis(100));
    assert!(capped.is_expired());
}

#[test]
fn dropping_the_clock_restores_real_time() {
    let before = {
        let _clock = VirtualClock::freeze();
        sleep(Duration::from_secs(3600));
        std::time::Instant::now()
    };

    let resumed = now();

    assert!(resumed >= before);
    assert!(resumed.saturating_duration_since(before) < Duration::from_secs(1800));
}
