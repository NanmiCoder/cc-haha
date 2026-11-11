use super::{Continuation, Frames};
use std::time::Instant;

/// A flourish plays for as long as `CURSOR_HIGHLIGHT_HOLD_MS`, and the control
/// behind it has under a second to be acknowledged. So a loop that ignored a
/// waiting control would spend that whole budget on an animation nothing is
/// looking at any more, which is the failure this signal exists to prevent.
#[test]
fn a_waiting_control_stops_the_loop_without_costing_it_a_frame() {
    let frames = Frames::at(60);
    let started = Instant::now();

    assert_eq!(frames.wait_unless(&|| true), Continuation::Stop);
    assert!(
        started.elapsed() < frames_interval_of_a_60hz_display(),
        "stopping must not sleep first"
    );
}

#[test]
fn nothing_waiting_plays_on() {
    let frames = Frames::at(60);
    assert_eq!(frames.wait_unless(&|| false), Continuation::Play);
    assert!(frames.elapsed_ms() < 1_000);
}

fn frames_interval_of_a_60hz_display() -> std::time::Duration {
    std::time::Duration::from_millis(16)
}
