use super::*;
use std::time::Instant;

#[test]
fn placement_can_arrive_after_the_first_read() {
    let started = Instant::now();
    let result = wait_for_placement(Deadline::after(2_000).unwrap(), || {
        Ok(started.elapsed() >= Duration::from_millis(240))
    });
    assert!(
        result.is_ok(),
        "the queued placement is still within its deadline: {result:?}"
    );
}

#[test]
fn an_unconfirmed_write_expires_without_becoming_safe_to_retry() {
    let started = Instant::now();
    let error = wait_for_placement(Deadline::after(100).unwrap(), || Ok(false)).unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn a_read_failure_is_preserved() {
    let error = wait_for_placement(Deadline::after(1_000).unwrap(), || {
        Err(AdapterError::new(
            agent_desktop_core::ErrorCode::WindowNotFound,
            "owner changed",
        )
        .with_disposition(DeliverySemantics::delivered_unverified()))
    })
    .unwrap_err();
    assert_eq!(error.code, agent_desktop_core::ErrorCode::WindowNotFound);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}
