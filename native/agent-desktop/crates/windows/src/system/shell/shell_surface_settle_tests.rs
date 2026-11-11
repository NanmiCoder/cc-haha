//! The foreign-shape call is made only after a landmark-free window has
//! stayed that way, so a surface that is still loading, or a toast arriving
//! during the raise, does not refuse an open that one more poll resolves.

use std::time::{Duration, Instant};

use super::{FOREIGN_SHAPE_SETTLE, foreign_shape_settled};

#[test]
fn a_first_foreign_reading_is_not_yet_a_foreign_shape() {
    let mut since = None;

    assert!(!foreign_shape_settled(&mut since, true, Instant::now()));
}

#[test]
fn a_foreign_reading_that_persists_past_the_settle_is_a_foreign_shape() {
    let start = Instant::now();
    let mut since = None;

    assert!(!foreign_shape_settled(&mut since, true, start));
    assert!(foreign_shape_settled(
        &mut since,
        true,
        start + FOREIGN_SHAPE_SETTLE
    ));
}

#[test]
fn a_reading_that_clears_restarts_the_settle() {
    let start = Instant::now();
    let mut since = None;

    assert!(!foreign_shape_settled(&mut since, true, start));
    assert!(!foreign_shape_settled(
        &mut since,
        false,
        start + Duration::from_millis(300)
    ));
    assert!(!foreign_shape_settled(
        &mut since,
        true,
        start + Duration::from_millis(600)
    ));
    assert!(since.is_some());
}
