use super::{caret_at, count_line_breaks, is_line_break};

#[test]
fn the_caret_takes_the_line_box_height_at_the_given_x() {
    let line = agent_desktop_core::Rect {
        x: 10.0,
        y: 40.0,
        width: 8.0,
        height: 18.0,
    };
    let caret = caret_at(18.0, &line);
    assert_eq!(
        (caret.x, caret.y, caret.width, caret.height),
        (18.0, 40.0, 2.0, 18.0)
    );
}

#[test]
fn line_breaks_of_every_kind_are_recognised() {
    for text in ["\r", "\n", "\r\n", "\u{2028}", "\u{2029}"] {
        assert!(is_line_break(text), "{text:?}");
    }
    assert!(!is_line_break("a"));
}

#[test]
fn crlf_counts_as_one_line_break() {
    assert_eq!(count_line_breaks("first\r\n\r\nthird\r\n"), 3);
    assert_eq!(count_line_breaks("a\rb\nc\u{2028}"), 3);
    assert_eq!(count_line_breaks("no breaks"), 0);
}
