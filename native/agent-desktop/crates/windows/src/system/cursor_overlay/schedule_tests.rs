use super::{
    clamp_refresh, frame_interval, has_arrived, highlight_progress, rest_fade, reveal_progress,
};
use std::time::Duration;

/// A29-7 measured the obvious refresh call failing on this host and leaving
/// its frequency at zero. A renderer that divided by that reading would take
/// an infinite frame rate; the floor is why it cannot.
#[test]
fn an_absent_refresh_reading_falls_back_rather_than_producing_no_interval() {
    assert_eq!(clamp_refresh(0), 60);
    assert_eq!(clamp_refresh(1), 60);
    assert_eq!(frame_interval(0), Duration::from_nanos(1_000_000_000 / 60));
}

#[test]
fn an_absurd_refresh_reading_is_capped_rather_than_believed() {
    assert_eq!(clamp_refresh(1_000), 240);
    assert!(frame_interval(1_000) >= Duration::from_nanos(1_000_000_000 / 240));
}

/// The reading this host actually gives, so the clamp is not silently
/// rewriting every real value.
#[test]
fn an_ordinary_refresh_reading_passes_through_unchanged() {
    assert_eq!(clamp_refresh(64), 64);
    assert_eq!(clamp_refresh(60), 60);
    assert_eq!(clamp_refresh(144), 144);
}

#[test]
fn arrival_is_answered_by_elapsed_time_not_by_a_frame_count() {
    assert!(!has_arrived(0, 200));
    assert!(!has_arrived(199, 200));
    assert!(has_arrived(200, 200));
    assert!(has_arrived(5_000, 200));
}

/// Core returns a zero duration when the cursor is already where it is going,
/// so a click on the current position must not wait for a travel.
#[test]
fn a_motion_with_nowhere_to_go_arrives_immediately() {
    assert!(has_arrived(0, 0));
}

/// A static outline would hold full opacity throughout. The curve is what keeps
/// Windows highlight from reading as a cruder cue than the macOS one it is
/// measured against.
#[test]
fn the_highlight_rises_holds_and_falls_rather_than_blinking() {
    let hold = 900;

    assert_eq!(highlight_progress(0, hold), 0.0);
    assert!(highlight_progress(30, hold) > 0.0 && highlight_progress(30, hold) < 1.0);
    assert_eq!(highlight_progress(400, hold), 1.0);
    assert!(highlight_progress(800, hold) > 0.0 && highlight_progress(800, hold) < 1.0);
    assert_eq!(highlight_progress(hold, hold), 0.0);
    assert_eq!(highlight_progress(hold + 1, hold), 0.0);
}

#[test]
fn the_highlight_never_leaves_the_unit_range() {
    for elapsed in (0..1_200).step_by(7) {
        let value = highlight_progress(elapsed, 900);
        assert!(
            (0.0..=1.0).contains(&value),
            "progress {value} at {elapsed}ms is outside the range a paint can use"
        );
    }
}

#[test]
fn a_zero_hold_never_shows_the_highlight() {
    assert_eq!(highlight_progress(0, 0), 0.0);
}

/// The reveal starts at nothing, ends at full, and decelerates - an ease-out
/// covers more of its distance early, which is what stops a card reading as
/// though it snapped.
#[test]
fn the_label_reveal_eases_out_rather_than_arriving_linearly() {
    assert_eq!(reveal_progress(0, 180), 0.0);
    assert_eq!(reveal_progress(180, 180), 1.0);
    assert_eq!(reveal_progress(500, 180), 1.0);

    let halfway = reveal_progress(90, 180);
    assert!(
        halfway > 0.5,
        "an ease-out is past halfway at the midpoint, not at it: {halfway}"
    );
    assert!(halfway < 1.0);

    let early = reveal_progress(45, 180);
    let late = reveal_progress(135, 180);
    assert!(
        early - 0.0 > 1.0 - late,
        "more of the distance is covered in the first quarter than the last: {early} then {late}"
    );
}

#[test]
fn a_reveal_with_no_duration_is_simply_present() {
    assert_eq!(reveal_progress(0, 0), 1.0);
}

/// The rest fade runs to nothing and starts from full, or the overlay either
/// never disappears or vanishes without fading.
#[test]
fn the_rest_fade_runs_from_full_to_nothing() {
    assert_eq!(rest_fade(0, 13), 1.0);
    assert_eq!(rest_fade(13, 13), 0.0);
    assert!(rest_fade(20, 13) == 0.0, "past the end stays gone");

    let mut previous = 2.0;
    for step in 0..=13 {
        let value = rest_fade(step, 13);
        assert!(value < previous, "step {step} did not descend: {value}");
        previous = value;
    }
}

#[test]
fn a_fade_with_no_steps_is_already_gone() {
    assert_eq!(rest_fade(0, 0), 0.0);
}
