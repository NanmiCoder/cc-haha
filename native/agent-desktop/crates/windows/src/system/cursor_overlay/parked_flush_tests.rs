use super::{MAX_PARKED_FLUSHES, ParkedFlush};
use std::sync::atomic::{AtomicUsize, Ordering};

static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// The ceiling is what bounds the leak: a client that never reads parks its
/// flush thread for good, so without a refusal one accumulates per control.
#[test]
fn claims_are_refused_once_the_ceiling_is_reached_and_freed_when_one_returns() {
    TEST_COUNTER.store(0, Ordering::SeqCst);
    let held: Vec<ParkedFlush> = (0..MAX_PARKED_FLUSHES)
        .map(|_| {
            ParkedFlush::claim_from(&TEST_COUNTER, MAX_PARKED_FLUSHES).expect("under the ceiling")
        })
        .collect();
    assert_eq!(TEST_COUNTER.load(Ordering::SeqCst), MAX_PARKED_FLUSHES);
    assert!(
        ParkedFlush::claim_from(&TEST_COUNTER, MAX_PARKED_FLUSHES).is_none(),
        "the ceiling refuses rather than growing without bound"
    );
    assert_eq!(
        TEST_COUNTER.load(Ordering::SeqCst),
        MAX_PARKED_FLUSHES,
        "a refused claim leaves the count where it was"
    );

    drop(held);
    assert_eq!(TEST_COUNTER.load(Ordering::SeqCst), 0);
    assert!(
        ParkedFlush::claim_from(&TEST_COUNTER, MAX_PARKED_FLUSHES).is_some(),
        "a flush that returns gives its slot back"
    );
}
