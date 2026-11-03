use super::super::raster::{Surface, SurfaceMapping};
use super::{draw_highlight, draw_label_pill, rounded_rect_distance, shadow_strength};
use agent_desktop_core::{Point, Rect};

const ACCENT: [f64; 3] = [0.26, 0.60, 1.0];

fn surface() -> Surface {
    Surface::try_transparent(200, 200).expect("bounded test surface")
}

fn mapping(scale: f64) -> SurfaceMapping {
    SurfaceMapping {
        origin: Point { x: 0.0, y: 0.0 },
        scale,
    }
}

/// The highlight is an outline, not a filled box: the element underneath has
/// to stay visible through it.
#[test]
fn the_highlight_is_an_outline_with_its_centre_untouched() {
    let mut surface = surface();
    let target = Rect {
        x: 60.0,
        y: 60.0,
        width: 80.0,
        height: 60.0,
    };

    draw_highlight(&mut surface, &mapping(1.0), &target, 1.0, ACCENT);

    assert_eq!(
        surface.alpha_at(100, 90),
        0,
        "the middle of the element stays clear, or the highlight hides what it points at"
    );
    assert!(
        surface.alpha_at(target.x as i32 - 3, 90) > 0,
        "the outline is painted just outside the element's edge"
    );
}

/// The curve is what keeps the cue from blinking on and off; a static outline
/// would paint identically at every opacity.
#[test]
fn the_highlights_opacity_follows_its_curve() {
    let mut faint = surface();
    let mut full = surface();
    let target = Rect {
        x: 60.0,
        y: 60.0,
        width: 80.0,
        height: 60.0,
    };

    draw_highlight(&mut faint, &mapping(1.0), &target, 0.2, ACCENT);
    draw_highlight(&mut full, &mapping(1.0), &target, 1.0, ACCENT);

    let peak = |surface: &Surface| {
        (0..surface.height)
            .flat_map(|y| (0..surface.width).map(move |x| (x, y)))
            .map(|(x, y)| surface.alpha_at(x, y))
            .max()
            .unwrap_or(0)
    };

    assert!(peak(&faint) < peak(&full));
    assert!(peak(&faint) > 0, "a faint highlight is still drawn");
}

#[test]
fn a_highlight_at_zero_opacity_paints_nothing() {
    let mut surface = surface();

    draw_highlight(
        &mut surface,
        &mapping(1.0),
        &Rect {
            x: 60.0,
            y: 60.0,
            width: 80.0,
            height: 60.0,
        },
        0.0,
        ACCENT,
    );

    assert!(surface.pixels.iter().all(|pixel| *pixel == 0));
}

/// The pill's ends are why its body is composited rather than alpha-forced
/// across its bounding rectangle: forcing would paint opaque square corners.
#[test]
fn the_label_pill_is_fully_rounded_black_and_opaque_in_its_body() {
    let mut surface = surface();
    let rect = Rect {
        x: 10.0,
        y: 10.0,
        width: 120.0,
        height: 24.0,
    };

    draw_label_pill(&mut surface, &rect, 1.0);

    assert!(
        surface.alpha_at(rect.x as i32, rect.y as i32) < 128,
        "the very corner of the bounding rectangle is outside a fully rounded pill"
    );
    let centre = surface
        .pixel_at(
            (rect.x + rect.width / 2.0) as i32,
            (rect.y + rect.height / 2.0) as i32,
        )
        .expect("inside the surface");
    assert_eq!(centre, 0xFF00_0000, "the body is opaque black");
    let below = surface.alpha_at(
        (rect.x + rect.width / 2.0) as i32,
        (rect.y + rect.height + 1.5) as i32,
    );
    assert!(
        below > 0 && below < 128,
        "a soft shadow falls below the pill"
    );
}

#[test]
fn the_shadow_fades_from_full_inside_to_none_a_blur_outside() {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 24.0,
    };
    assert!(rounded_rect_distance(&rect, 12.0, 50.0, 12.0) < 0.0);
    assert_eq!(rounded_rect_distance(&rect, 12.0, 50.0, 30.0), 6.0);
    assert_eq!(shadow_strength(-5.0, 2.5), 1.0);
    assert_eq!(shadow_strength(5.0, 2.5), 0.0);
    assert_eq!(shadow_strength(0.0, 2.5), 0.5);
}

#[path = "rounded_equivalence_tests.rs"]
mod equivalence;
