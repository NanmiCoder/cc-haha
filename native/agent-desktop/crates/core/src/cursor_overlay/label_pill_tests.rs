use super::*;

#[test]
fn the_pill_grows_with_its_text_and_keeps_its_padding() {
    let short = LabelPill::for_label("Go", 14.0, 1.0).expect("a pill");
    let long = LabelPill::for_label("Opening the release notes", 160.0, 1.0).expect("a pill");

    assert_eq!(short.size(), (34.0, LABEL_PILL_HEIGHT));
    assert_eq!(long.size(), (180.0, LABEL_PILL_HEIGHT));
    assert_eq!(long.corner_radius(), LABEL_PILL_HEIGHT / 2.0);
}

#[test]
fn the_text_is_centred_across_and_down() {
    let pill = LabelPill::for_label("Opening menu", 80.0, 1.0).expect("a pill");
    let text = pill.text_frame(16.0);
    let (width, height) = pill.size();

    assert_eq!(text.x, LABEL_PILL_PADDING);
    assert_eq!(text.x + text.width + text.x, width);
    assert_eq!(text.y + text.height + text.y, height);
}

#[test]
fn an_empty_label_shows_no_pill() {
    assert_eq!(LabelPill::for_label("", 0.0, 1.0), None);
    assert_eq!(LabelPill::for_label("   ", 12.0, 1.0), None);
}

#[test]
fn a_long_label_stops_at_the_widest_pill_and_scales_with_the_cursor() {
    let capped = LabelPill::for_label("x", 5_000.0, 1.0).expect("a pill");
    assert_eq!(capped.size().0, LABEL_PILL_MAX_WIDTH);
    let doubled = LabelPill::for_label("Go", 28.0, 2.0).expect("a pill");
    assert_eq!(doubled.size(), (68.0, LABEL_PILL_HEIGHT * 2.0));
    assert_eq!(doubled.text_frame(30.0).x, LABEL_PILL_PADDING * 2.0);
}

#[test]
fn the_pill_sits_right_of_and_below_the_tip() {
    let screen = Rect {
        x: 0.0,
        y: 0.0,
        width: 1000.0,
        height: 800.0,
    };
    let pill = LabelPill::for_label("Opening menu", 80.0, 1.0).expect("a pill");
    let placed = crate::place_label(&crate::Point { x: 100.0, y: 100.0 }, pill.size(), &screen);

    assert_eq!((placed.x, placed.y), (120.0, 130.0));
    assert_eq!((placed.width, placed.height), pill.size());
}

/// A pill clamped to a narrow screen keeps its padding and gives the text
/// only the room left, so the text and its ellipsis stay inside the pill.
#[test]
fn a_pill_cut_down_to_the_screen_cuts_its_text_room_too() {
    let pill = LabelPill::for_label("a long label", 300.0, 2.0).expect("a pill");
    let cut = pill.within(200.0);
    let text = cut.text_frame(20.0);

    assert_eq!(cut.size().0, 200.0);
    assert_eq!(text.x, LABEL_PILL_PADDING * 2.0);
    assert_eq!(text.x + text.width + text.x, 200.0);
    assert_eq!(
        pill.within(1_000.0),
        pill,
        "a wide enough screen leaves it alone"
    );
}
