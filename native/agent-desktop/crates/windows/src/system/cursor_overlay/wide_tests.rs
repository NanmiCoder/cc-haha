use super::wide;

/// The terminator is the whole reason this exists. A `W` entry point reads
/// until it finds one, so a buffer without it is read past its end - a bug
/// that shows up as a corrupted pipe name or a garbage window class rather
/// than as anything pointing here.
#[test]
fn the_buffer_ends_with_the_terminator_the_win32_call_looks_for() {
    let encoded = wide("agent-desktop");

    assert_eq!(
        encoded.last(),
        Some(&0),
        "a W entry point reads to the first zero, so a buffer without one is read past its end"
    );
    assert_eq!(encoded.len(), "agent-desktop".chars().count() + 1);
}

/// An empty string still has to produce a buffer, not an empty slice: the
/// pointer is handed to Win32 either way, and an empty vector has nothing
/// valid to point at.
#[test]
fn an_empty_string_still_yields_something_to_point_at() {
    assert_eq!(wide(""), vec![0]);
}

/// A character outside the basic plane becomes two code units, so a caller
/// that sized a buffer from the character count would be wrong. Nothing here
/// does, and this pins that the encoding is UTF-16 rather than a truncation.
#[test]
fn a_character_outside_the_basic_plane_becomes_a_surrogate_pair() {
    let encoded = wide("\u{1F5B1}");

    assert_eq!(encoded.len(), 3, "two code units and the terminator");
    assert!(encoded[0] >= 0xD800 && encoded[0] <= 0xDBFF);
    assert!(encoded[1] >= 0xDC00 && encoded[1] <= 0xDFFF);
}
