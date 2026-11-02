use super::super::geometry;
use super::{
    Paint, Surface, SurfaceMapping, distance_to_polygon, draw_glyph, draw_ripple, fill_region,
    point_in_polygon,
};
use agent_desktop_core::{Point, Rect};

const FILL: [f64; 3] = [1.0, 1.0, 1.0];
const RIM: [f64; 3] = [0.07, 0.07, 0.09];
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

fn edge_alphas(surface: &Surface) -> Vec<u8> {
    let mut seen = Vec::new();
    for y in 0..surface.height {
        for x in 0..surface.width {
            let alpha = surface.alpha_at(x, y);
            if alpha > 0 && alpha < 255 {
                seen.push(alpha);
            }
        }
    }
    seen
}

#[test]
fn an_untouched_surface_is_fully_transparent() {
    let surface = surface();

    assert!(surface.pixels.iter().all(|pixel| *pixel == 0));
    assert_eq!(surface.alpha_at(10, 10), 0);
}

#[test]
fn a_surface_with_unbounded_pixel_count_is_rejected_without_allocation() {
    assert!(Surface::try_transparent(100_000, 100_000).is_none());
    assert!(Surface::try_transparent(-1, 10).is_none());
}

/// The whole reason this module exists. A GDI `Polygon` would leave the alpha
/// byte at zero across the glyph, so nothing would appear under `ULW_ALPHA`;
/// forcing alpha across its rectangle afterwards would square off the edges.
/// Intermediate alpha at the edge is the proof the per-pixel path ran.
#[test]
fn the_glyph_carries_full_alpha_inside_and_partial_alpha_at_its_edge() {
    let mut surface = surface();

    draw_glyph(
        &mut surface,
        &mapping(1.0),
        &Point { x: 40.0, y: 40.0 },
        FILL,
        RIM,
    );

    assert!(
        surface.pixels.iter().any(|pixel| (pixel >> 24) == 0xFF),
        "the glyph's interior must be opaque, or nothing is visible"
    );
    assert!(
        !edge_alphas(&surface).is_empty(),
        "an anti-aliased edge carries partial alpha; a GDI draw would have left every pixel \
         at zero, and a rectangle alpha-force would have left every pixel at 255"
    );
    assert!(
        surface.pixels.contains(&0),
        "the surface outside the glyph stays transparent"
    );
}

#[test]
fn the_glyphs_tip_is_painted_where_the_pose_points() {
    let mut surface = surface();
    let tip = Point { x: 60.0, y: 60.0 };

    draw_glyph(&mut surface, &mapping(1.0), &tip, FILL, RIM);

    let near_tip = surface.alpha_at(tip.x as i32, tip.y as i32);
    assert!(
        near_tip > 0,
        "the dart's tip lands on the pose point, not the corner of its box"
    );
}

/// The mapping is the surface's whole relationship to the screen, so an
/// origin that were ignored would draw the right shape in the wrong place -
/// which is exactly what bundling it with the scale is meant to make hard.
#[test]
fn the_mappings_origin_shifts_what_is_drawn_by_that_much() {
    let tip = Point { x: 90.0, y: 90.0 };
    let mut at_zero = surface();
    let mut shifted = surface();

    draw_glyph(&mut at_zero, &mapping(1.0), &tip, FILL, RIM);
    draw_glyph(
        &mut shifted,
        &SurfaceMapping {
            origin: Point { x: 30.0, y: 20.0 },
            scale: 1.0,
        },
        &tip,
        FILL,
        RIM,
    );

    let painted = |surface: &Surface| surface.pixels.iter().filter(|pixel| **pixel != 0).count();
    assert!(painted(&at_zero) > 0 && painted(&at_zero) == painted(&shifted));
    for y in 20..200 {
        for x in 30..200 {
            assert_eq!(
                at_zero.pixel_at(x, y),
                shifted.pixel_at(x - 30, y - 20),
                "the glyph moved by something other than the origin at {x},{y}"
            );
        }
    }
}

/// A ripple that never fades would be a solid disc rather than an effect.
#[test]
fn the_ripple_expands_and_fades_across_its_phase() {
    let tip = Point { x: 100.0, y: 100.0 };
    let mut early = surface();
    let mut late = surface();

    draw_ripple(&mut early, &mapping(1.0), &tip, 0.15, ACCENT);
    draw_ripple(&mut late, &mapping(1.0), &tip, 0.9, ACCENT);

    let radius_of = |surface: &Surface| {
        let mut furthest = 0.0_f64;
        for y in 0..surface.height {
            for x in 0..surface.width {
                if surface.alpha_at(x, y) > 0 {
                    furthest = furthest.max((f64::from(x) - 100.0).hypot(f64::from(y) - 100.0));
                }
            }
        }
        furthest
    };

    assert!(
        radius_of(&late) > radius_of(&early),
        "the ring expands as the phase advances"
    );
    assert!(
        !edge_alphas(&early).is_empty(),
        "the ripple's edge is soft, which a GDI Ellipse could not produce here"
    );
}

#[test]
fn a_ripple_outside_its_phase_paints_nothing() {
    let mut surface = surface();

    draw_ripple(
        &mut surface,
        &mapping(1.0),
        &Point { x: 100.0, y: 100.0 },
        0.0,
        ACCENT,
    );

    assert!(surface.pixels.iter().all(|pixel| *pixel == 0));
}

#[test]
fn nothing_is_written_outside_the_surface() {
    let mut surface = Surface::try_transparent(24, 24).expect("bounded test surface");

    draw_glyph(
        &mut surface,
        &mapping(4.0),
        &Point { x: 500.0, y: 500.0 },
        FILL,
        RIM,
    );
    draw_ripple(
        &mut surface,
        &mapping(4.0),
        &Point {
            x: -400.0,
            y: -400.0,
        },
        0.5,
        ACCENT,
    );

    assert!(
        surface.pixels.iter().all(|pixel| *pixel == 0),
        "both targets lie wholly off the surface, so any lit pixel is a clamp defect"
    );
}

/// The glyph as it was drawn before the origin and the scale were bundled:
/// the same arithmetic, spelled with two loose arguments. Bundling is a
/// refactor, so it owes the same debt an optimization does - the same pixels
/// - and this is what that is checked against.
fn reference_glyph(surface: &mut Surface, origin: &Point, tip: &Point, scale: f64) {
    let rect = geometry::glyph_rect(tip, scale);
    let points: Vec<(f64, f64)> = geometry::DART
        .iter()
        .map(|(x, y)| (rect.x - origin.x + x * scale, rect.y - origin.y + y * scale))
        .collect();
    let local = Rect {
        x: rect.x - origin.x - geometry::GLYPH_RIM_WIDTH * scale,
        y: rect.y - origin.y - geometry::GLYPH_RIM_WIDTH * scale,
        width: rect.width + geometry::GLYPH_RIM_WIDTH * scale * 2.0,
        height: rect.height + geometry::GLYPH_RIM_WIDTH * scale * 2.0,
    };
    let rim_width = geometry::GLYPH_RIM_WIDTH * scale * 0.5;

    let rim_points = points.clone();
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: RIM,
            alpha: 1.0,
        },
        |x, y| {
            point_in_polygon(&rim_points, x, y)
                || distance_to_polygon(&rim_points, x, y) <= rim_width
        },
    );
    let fill_points = points;
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: FILL,
            alpha: 1.0,
        },
        |x, y| point_in_polygon(&fill_points, x, y),
    );
}

/// The ripple as it was drawn before the bundling, for the same reason.
fn reference_ripple(surface: &mut Surface, origin: &Point, tip: &Point, scale: f64, phase: f64) {
    if phase <= 0.0 || phase > 1.0 {
        return;
    }
    let rect = geometry::ripple_rect(tip, scale);
    let local = Rect {
        x: rect.x - origin.x,
        y: rect.y - origin.y,
        width: rect.width,
        height: rect.height,
    };
    let centre_x = local.x + local.width / 2.0;
    let centre_y = local.y + local.height / 2.0;
    let fade = 1.0 - phase;

    let core = geometry::RIPPLE_CORE_RADIUS * scale * (1.0 - phase * 0.4);
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: ACCENT,
            alpha: 0.55 * fade,
        },
        |x, y| (x - centre_x).hypot(y - centre_y) <= core,
    );

    let ring = (geometry::RIPPLE_SIZE * 0.5 - geometry::RIPPLE_RING_INSET) * scale * phase;
    let thickness = 3.0 * scale;
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: ACCENT,
            alpha: 0.85 * fade,
        },
        |x, y| {
            let distance = (x - centre_x).hypot(y - centre_y);
            distance <= ring && distance >= ring - thickness
        },
    );
}

#[test]
fn bundling_the_origin_and_the_scale_left_every_pixel_where_it_was() {
    for (x, y) in [(0.0, 0.0), (11.4, 6.6), (-8.25, 13.75)] {
        for scale in [0.6, 1.0, 1.35, 2.0] {
            for phase in [0.2, 0.75] {
                let origin = Point { x, y };
                let tip = Point {
                    x: 96.3 + x,
                    y: 88.7 + y,
                };
                let mapping = SurfaceMapping {
                    origin: origin.clone(),
                    scale,
                };

                let mut bundled = surface();
                draw_ripple(&mut bundled, &mapping, &tip, phase, ACCENT);
                draw_glyph(&mut bundled, &mapping, &tip, FILL, RIM);
                let mut loose = surface();
                reference_ripple(&mut loose, &origin, &tip, scale, phase);
                reference_glyph(&mut loose, &origin, &tip, scale);

                assert!(
                    bundled.pixels.iter().any(|pixel| *pixel != 0),
                    "origin {x},{y} scale {scale} drew nothing to compare"
                );
                assert_eq!(
                    bundled.pixels, loose.pixels,
                    "origin {x},{y} scale {scale} phase {phase} moved a pixel"
                );
            }
        }
    }
}
