use super::*;

#[test]
fn late_matching_observation_is_discarded() {
    let current = baseline_with_windows(vec![window("w-late", "Too late")]);
    let adapter = SequenceAdapter::new(vec![current]).with_delay(Duration::from_millis(30));
    let mut request = input("window-opened", None);
    request.timeout_ms = 10;

    let error = wait_for_event(request, &adapter, Some(Ok(empty_baseline())))
        .expect_err("an observation returned after the deadline must not match");

    assert_eq!(error.code(), "TIMEOUT");
    assert_eq!(*adapter.calls.lock().unwrap(), 1);
    let remaining = adapter.remaining_at_call.lock().unwrap()[0];
    assert!(remaining > Duration::ZERO);
    assert!(remaining <= Duration::from_millis(10));
}

#[test]
fn zero_timeout_has_one_event_wait_shape_without_starting_observation() {
    for &event in EventKind::all_tokens() {
        for app in [None, Some("TextEdit")] {
            let adapter = SequenceAdapter::new(vec![empty_baseline()]);
            let mut request = input(event, app);
            request.timeout_ms = 0;

            let error = wait_for_event(request, &adapter, None).unwrap_err();
            assert_eq!(error.code(), "TIMEOUT");
            let AppError::Adapter(error) = error else {
                panic!("expected a wait timeout")
            };
            let details = error.details.unwrap();
            assert_eq!(details["kind"], "wait_timeout");
            assert_eq!(details["predicate"], "event");
            assert_eq!(details["event"], event);
            assert_eq!(details["timeout_ms"], 0);
            assert!(details.get("baseline_counts").unwrap().is_null());
            assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
            assert_eq!(*adapter.calls.lock().unwrap(), 0);
        }
    }
}

#[test]
fn oversized_timeout_cannot_overflow_the_deadline() {
    let adapter = SequenceAdapter::new(vec![empty_baseline()]);
    let mut request = input("window-opened", Some("TextEdit"));
    request.timeout_ms = u64::MAX;

    let error = wait_for_event(request, &adapter, None)
        .expect_err("an unrepresentable timeout must be rejected before any observation");

    assert_eq!(error.code(), "INVALID_ARGS");
    assert_eq!(*adapter.app_calls.lock().unwrap(), 0);
    assert_eq!(*adapter.calls.lock().unwrap(), 0);
}

#[test]
fn parse_event_kind_accepts_every_documented_token() {
    for token in EventKind::all_tokens() {
        assert!(
            parse_event_kind(token).is_ok(),
            "token '{token}' from EventKind::all_tokens() must parse"
        );
    }
}
use std::time::Duration;
