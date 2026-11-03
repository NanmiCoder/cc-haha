use super::{new_line_caret, paragraph_start};
use agent_desktop_core::Rect;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn place(caret: Option<Rect>) -> Option<(f64, f64, f64)> {
    caret.map(|caret| (caret.x, caret.y, caret.height))
}

#[test]
fn the_paragraph_above_starts_after_the_last_line_break() {
    assert_eq!(paragraph_start("title\n\nfirst\nsecond"), Some(13));
    assert_eq!(paragraph_start("only line"), Some(0));
}

#[test]
fn offsets_count_utf16_units() {
    assert_eq!(paragraph_start("caf\u{e9} \u{1f600}\nnext"), Some(8));
}

#[test]
fn an_empty_paragraph_above_has_no_start() {
    assert_eq!(paragraph_start("title\n"), None);
    assert_eq!(paragraph_start(""), None);
}

#[test]
fn the_character_at_the_insertion_point_places_the_caret_when_text_follows() {
    let next = rect(62.0, 269.0, 354.0, 16.0);
    let caret = new_line_caret(Some(next), None, None, Some(rect(62.0, 253.0, 0.0, 16.0)));
    assert_eq!(place(caret), Some((62.0, 269.0, 16.0)));
}

#[test]
fn at_the_end_the_caret_lines_up_with_the_text_of_the_paragraph_above() {
    let first = rect(62.0, 247.0, 8.0, 16.0);
    let last = rect(129.0, 247.0, 6.0, 16.0);
    let insertion = rect(39.0, 266.0, 0.0, 17.0);
    let caret = new_line_caret(None, Some(first), Some(last), Some(insertion));
    assert_eq!(place(caret), Some((62.0, 266.0, 17.0)));
}

#[test]
fn an_insertion_point_reported_on_the_line_above_is_moved_below_it() {
    let first = rect(20.0, 100.0, 8.0, 16.0);
    let last = rect(90.0, 100.0, 6.0, 16.0);
    let insertion = rect(20.0, 100.0, 0.0, 16.0);
    let caret = new_line_caret(None, Some(first), Some(last), Some(insertion));
    assert_eq!(place(caret), Some((20.0, 116.0, 16.0)));
}

#[test]
fn no_caret_shows_when_there_is_nothing_to_line_up_with() {
    let insertion = Some(rect(39.0, 266.0, 0.0, 17.0));
    assert_eq!(new_line_caret(None, None, None, insertion), None);
}
