use super::Presentation;
use crate::system::cursor_overlay::geometry::glyph_rect;
use agent_desktop_core::Point;

#[test]
fn per_monitor_dpi_changes_the_arrow_size_without_moving_the_hotspot() {
    let tip = Point {
        x: -450.0,
        y: 570.0,
    };
    let mut presentation = Presentation::resting_at(tip.clone());
    presentation.style.set_size(1.25);

    let standard = glyph_rect(&tip, presentation.shown_style(1.0).size());
    let scaled = glyph_rect(&tip, presentation.shown_style(2.0).size());

    assert_eq!((standard.x, standard.y), (tip.x, tip.y));
    assert_eq!((scaled.x, scaled.y), (tip.x, tip.y));
    assert_eq!(scaled.width, standard.width * 2.0);
    assert_eq!(scaled.height, standard.height * 2.0);
    assert_eq!(presentation.style.size(), 1.25);
}
