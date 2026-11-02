use super::{FIRST_RETRY_PAUSE, MAXIMUM_RETRY_PAUSE, next_retry_pause};

/// The pause doubles so a provider that is genuinely struggling is not polled
/// at the opening rate for the whole budget, and it stops doubling so a long
/// deadline cannot stretch one pause past the point of usefulness.
#[test]
fn the_retry_pause_doubles_up_to_its_ceiling_and_stays_there() {
    let first = FIRST_RETRY_PAUSE;
    let second = next_retry_pause(first);
    assert_eq!(
        second,
        first * 2,
        "the pause backs off rather than repeating"
    );

    let mut pause = first;
    for _ in 0..12 {
        pause = next_retry_pause(pause);
    }
    assert_eq!(pause, MAXIMUM_RETRY_PAUSE, "backoff settles at the ceiling");
    assert_eq!(
        next_retry_pause(pause),
        MAXIMUM_RETRY_PAUSE,
        "the ceiling holds instead of growing without bound"
    );
}
