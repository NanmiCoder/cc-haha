use super::{draw_label, measure_label};
use crate::system::cursor_overlay::raster::Surface;
use agent_desktop_core::Rect;

const BODY: u32 = 0xFF20_3040;
const INK: [f64; 3] = [1.0, 1.0, 1.0];

fn opaque_card(width: i32, height: i32) -> Surface {
    let mut surface = Surface::try_transparent(width, height).expect("bounded test surface");
    for pixel in &mut surface.pixels {
        *pixel = BODY;
    }
    surface
}

fn pixels_differing_from_the_body(surface: &Surface, rect: &Rect) -> usize {
    let mut differing = 0;
    for y in 0..rect.height as i32 {
        for x in 0..rect.width as i32 {
            let sampled = surface.pixel_at(rect.x as i32 + x, rect.y as i32 + y);
            if sampled.is_some_and(|value| value != BODY) {
                differing += 1;
            }
        }
    }
    differing
}

/// The card body is asserted elsewhere; nothing asserted that a glyph was ever
/// rasterized onto it.
///
/// The gap matters because of how the text gets there. GDI writes RGB and
/// leaves the alpha byte at zero, so the glyphs are visible only where the
/// body beneath them is already opaque and the alpha is written back by hand
/// as they are copied in. Break either half and the label is drawn onto
/// transparency: under `ULW_ALPHA` the card still appears, correctly shaped
/// and correctly coloured, and simply says nothing. A caption that silently
/// stops arriving is the whole point of the caption gone, with a frame that
/// looks right in every other respect.
#[test]
fn a_label_puts_ink_on_the_card() {
    let rect = Rect {
        x: 4.0,
        y: 4.0,
        width: 220.0,
        height: 40.0,
    };
    let mut surface = opaque_card(240, 48);

    assert_eq!(
        pixels_differing_from_the_body(&surface, &rect),
        0,
        "the card must start as one flat colour, or the count below proves nothing"
    );

    draw_label(&mut surface, &rect, "Opening the menu", INK, 22.0);

    assert!(
        pixels_differing_from_the_body(&surface, &rect) > 40,
        "no glyph reached the card: the text rectangle is still the body colour"
    );
}

/// The alpha byte is the half that `ULW_ALPHA` reads. Ink that landed with a
/// zero alpha is ink nobody sees.
#[test]
fn the_ink_is_opaque_where_it_landed() {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 200.0,
        height: 36.0,
    };
    let mut surface = opaque_card(200, 36);
    draw_label(&mut surface, &rect, "Opening the menu", INK, 22.0);

    let transparent = (0..36)
        .flat_map(|y| (0..200).map(move |x| (x, y)))
        .filter(|(x, y)| surface.alpha_at(*x, *y) != 0xFF)
        .count();
    assert_eq!(
        transparent, 0,
        "every pixel the label was copied over must stay opaque"
    );
}

/// The pill is sized from this measurement, so it has to grow with the text.
#[test]
fn a_longer_label_measures_wider() {
    let short = measure_label("Go", 12.5).expect("a measurable label");
    let long = measure_label("Opening the menu", 12.5).expect("a measurable label");

    assert!(short > 0.0);
    assert!(long > short * 3.0, "{long} is not much wider than {short}");
}

/// The ink is centred in its rectangle across and down, rather than starting
/// at the left edge.
#[test]
fn the_label_is_centred_in_its_rectangle() {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 200.0,
        height: 30.0,
    };
    let mut surface = opaque_card(200, 30);
    draw_label(&mut surface, &rect, "Go", INK, 16.0);

    let inked: Vec<(i32, i32)> = (0..30)
        .flat_map(|y| (0..200).map(move |x| (x, y)))
        .filter(|(x, y)| surface.pixel_at(*x, *y).is_some_and(|value| value != BODY))
        .collect();
    assert!(!inked.is_empty(), "the label drew no ink");
    let (left, right) = inked.iter().fold((i32::MAX, i32::MIN), |(l, r), (x, _)| {
        (l.min(*x), r.max(*x))
    });
    let (top, bottom) = inked.iter().fold((i32::MAX, i32::MIN), |(t, b), (_, y)| {
        (t.min(*y), b.max(*y))
    });
    assert!(
        ((left + right) as f64 / 2.0 - 100.0).abs() <= 2.0,
        "{left}..{right}"
    );
    assert!(
        ((top + bottom) as f64 / 2.0 - 15.0).abs() <= 3.0,
        "{top}..{bottom}"
    );
}
