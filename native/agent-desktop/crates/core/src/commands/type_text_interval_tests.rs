use super::keystroke_units;

#[test]
fn plain_text_types_one_character_per_keystroke() {
    assert_eq!(
        keystroke_units("hi there"),
        ["h", "i", " ", "t", "h", "e", "r", "e"]
    );
}

#[test]
fn a_combining_mark_types_with_its_base_character() {
    assert_eq!(
        keystroke_units("e\u{0301}t\u{00E9}"),
        ["e\u{0301}", "t", "\u{00E9}"]
    );
}

#[test]
fn joined_emoji_and_modifiers_type_as_one_keystroke() {
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let wave = "\u{1F44B}\u{1F3FD}";
    assert_eq!(
        keystroke_units(&format!("{family}{wave}!")),
        [family, wave, "!"]
    );
}

#[test]
fn crlf_types_as_one_keystroke_and_lf_alone_stays_alone() {
    assert_eq!(keystroke_units("a\r\nb\nc"), ["a", "\r\n", "b", "\n", "c"]);
}

#[path = "type_text_interval_wait_tests.rs"]
mod wait;

#[test]
fn the_next_keystroke_is_due_an_interval_after_its_slot_or_half_one_after_a_late_landing() {
    use std::time::{Duration, Instant};
    let slot = Instant::now();
    let interval = Duration::from_millis(100);

    assert_eq!(
        super::next_due(slot, slot + Duration::from_millis(10), interval),
        slot + interval
    );
    let late = slot + Duration::from_millis(350);
    assert_eq!(super::next_due(slot, late, interval), late + interval / 2);
}

#[path = "type_text_interval_clock_tests.rs"]
mod clock;

#[path = "type_text_interval_caret_tests.rs"]
mod caret;
