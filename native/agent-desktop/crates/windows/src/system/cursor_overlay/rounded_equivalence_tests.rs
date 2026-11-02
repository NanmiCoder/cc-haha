//! The proof that hollowing the highlight's walk changed nothing but its cost.
//!
//! An optimization's only acceptable outcome is the same pixels, so the
//! surfaces are compared byte for byte: against digests recorded from the
//! rasterizer that walked the full padded rectangle, and against that
//! rasterizer itself over a sweep of the sizes between them.

use super::super::super::geometry;
use super::super::super::raster::{Paint, Surface, SurfaceMapping, fill_region};
use super::super::{draw_highlight, in_rounded_rect};
use agent_desktop_core::{Point, Rect};

const ACCENT: [f64; 3] = [0.26, 0.60, 1.0];

/// A case the highlight is rasterized against byte for byte.
struct HighlightCase {
    name: &'static str,
    surface: (i32, i32),
    origin: Point,
    target: Rect,
    scale: f64,
    opacity: f64,
}

impl HighlightCase {
    fn paint(&self, painter: impl Fn(&mut Surface, &SurfaceMapping, &Rect, f64)) -> Surface {
        let mut surface =
            Surface::try_transparent(self.surface.0, self.surface.1).expect("bounded test surface");
        let mapping = SurfaceMapping {
            origin: self.origin.clone(),
            scale: self.scale,
        };
        painter(&mut surface, &mapping, &self.target, self.opacity);
        surface
    }
}

fn highlight_cases() -> Vec<HighlightCase> {
    vec![
        HighlightCase {
            name: "small",
            surface: (320, 160),
            origin: Point { x: 40.3, y: 41.7 },
            target: Rect {
                x: 60.3,
                y: 61.7,
                width: 220.0,
                height: 44.0,
            },
            scale: 1.0,
            opacity: 1.0,
        },
        HighlightCase {
            name: "large",
            surface: (660, 460),
            origin: Point { x: 0.0, y: 0.0 },
            target: Rect {
                x: 10.5,
                y: 12.25,
                width: 600.0,
                height: 400.0,
            },
            scale: 1.0,
            opacity: 1.0,
        },
        HighlightCase {
            name: "narrower than two border strips",
            surface: (120, 160),
            origin: Point { x: 20.0, y: 20.0 },
            target: Rect {
                x: 40.7,
                y: 45.2,
                width: 6.0,
                height: 90.0,
            },
            scale: 1.0,
            opacity: 1.0,
        },
        HighlightCase {
            name: "flatter than two border strips",
            surface: (200, 120),
            origin: Point { x: 20.0, y: 20.0 },
            target: Rect {
                x: 40.7,
                y: 45.2,
                width: 120.0,
                height: 4.0,
            },
            scale: 1.0,
            opacity: 1.0,
        },
        HighlightCase {
            name: "degenerate in both axes",
            surface: (80, 80),
            origin: Point { x: 20.0, y: 20.0 },
            target: Rect {
                x: 41.4,
                y: 42.6,
                width: 0.0,
                height: 0.0,
            },
            scale: 1.0,
            opacity: 1.0,
        },
        HighlightCase {
            name: "faint",
            surface: (320, 160),
            origin: Point { x: 40.3, y: 41.7 },
            target: Rect {
                x: 60.3,
                y: 61.7,
                width: 220.0,
                height: 44.0,
            },
            scale: 1.0,
            opacity: 0.35,
        },
        HighlightCase {
            name: "scaled and translucent",
            surface: (260, 220),
            origin: Point { x: 10.9, y: 12.1 },
            target: Rect {
                x: 44.25,
                y: 46.75,
                width: 120.0,
                height: 90.0,
            },
            scale: 1.4,
            opacity: 0.8,
        },
        HighlightCase {
            name: "scaled and degenerate",
            surface: (140, 160),
            origin: Point { x: 10.9, y: 12.1 },
            target: Rect {
                x: 44.25,
                y: 46.75,
                width: 9.0,
                height: 70.0,
            },
            scale: 2.5,
            opacity: 1.0,
        },
    ]
}

fn shipped(surface: &mut Surface, mapping: &SurfaceMapping, target: &Rect, opacity: f64) {
    draw_highlight(surface, mapping, target, opacity, ACCENT);
}

/// The rasterizer the strip walk replaced: the whole padded rectangle tested
/// pixel by pixel, interior included. Kept here so the optimization is checked
/// against the thing it optimized rather than only against itself, over more
/// cases than a recorded digest can carry.
fn full_rectangle_reference(
    surface: &mut Surface,
    mapping: &SurfaceMapping,
    target: &Rect,
    opacity: f64,
) {
    if opacity <= 0.0 {
        return;
    }
    let scale = mapping.scale;
    let rect = geometry::highlight_rect(target, scale);
    let outer = Rect {
        x: rect.x - mapping.origin.x,
        y: rect.y - mapping.origin.y,
        width: rect.width,
        height: rect.height,
    };
    let radius = geometry::HIGHLIGHT_CORNER_RADIUS * scale;
    let border = geometry::HIGHLIGHT_BORDER_WIDTH * scale;
    let inner = Rect {
        x: outer.x + border,
        y: outer.y + border,
        width: (outer.width - border * 2.0).max(0.0),
        height: (outer.height - border * 2.0).max(0.0),
    };
    fill_region(
        surface,
        &outer,
        &Paint {
            rgb: ACCENT,
            alpha: opacity,
        },
        |x, y| {
            in_rounded_rect(&outer, radius, x, y)
                && !in_rounded_rect(&inner, (radius - border).max(0.0), x, y)
        },
    );
}

fn digest(surface: &Surface) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut fold = |byte: u8| {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for byte in surface.width.to_le_bytes() {
        fold(byte);
    }
    for byte in surface.height.to_le_bytes() {
        fold(byte);
    }
    for pixel in &surface.pixels {
        for byte in pixel.to_le_bytes() {
            fold(byte);
        }
    }
    hash
}

fn highlight_digests() -> String {
    highlight_cases()
        .iter()
        .map(|case| format!("{} {:#018x}", case.name, digest(&case.paint(shipped))))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Recorded from the rasterizer that walked the highlight's full padded
/// rectangle and threw its interior away. The strip walk that replaced it is
/// an optimization, so the only acceptable outcome is the same bytes: a
/// difference here is a defect in the strips, never a stale expectation.
const HIGHLIGHT_DIGESTS: &str = "\
small 0x1fda45c072d7ca52
large 0xd34d3423b356b7cf
narrower than two border strips 0x47a02ece5a51e80a
flatter than two border strips 0x79560cd511b3129d
degenerate in both axes 0xfe51d9a79d57fc52
faint 0xc5f7ed1d8fcafd22
scaled and translucent 0xb44e1ead43f4a51a
scaled and degenerate 0xf23c3026a02c7246";

#[test]
fn the_highlight_rasterizes_to_the_bytes_it_always_has() {
    assert_eq!(highlight_digests(), HIGHLIGHT_DIGESTS);
}

/// A digest of an empty surface would agree with itself forever, so the cases
/// the digests pin have to be shown to paint something first.
#[test]
fn every_recorded_highlight_case_paints_pixels() {
    for case in highlight_cases() {
        let painted = case
            .paint(shipped)
            .pixels
            .iter()
            .filter(|pixel| **pixel != 0)
            .count();
        assert!(
            painted > 20,
            "{} painted only {painted} pixels, so its digest pins nothing",
            case.name
        );
    }
}

/// Eight recorded cases pin the change that was made; this sweep covers the
/// sizes, offsets and scales between them, where a strip that missed a row or
/// painted a corner twice would otherwise hide.
#[test]
fn the_strip_walk_paints_what_the_full_rectangle_walk_painted() {
    for width in [0.0, 3.0, 9.0, 21.0, 22.0, 47.0, 130.0] {
        for height in [0.0, 5.0, 20.0, 21.0, 63.0, 108.0] {
            for (offset, scale) in [(0.0, 1.0), (0.5, 1.0), (0.37, 1.75), (0.5, 0.6)] {
                let case = HighlightCase {
                    name: "sweep",
                    surface: (260, 220),
                    origin: Point {
                        x: 7.0 + offset,
                        y: 11.0 - offset,
                    },
                    target: Rect {
                        x: 30.0 + offset,
                        y: 34.0 + offset,
                        width,
                        height,
                    },
                    scale,
                    opacity: 0.75,
                };

                assert_eq!(
                    case.paint(shipped).pixels,
                    case.paint(full_rectangle_reference).pixels,
                    "{width}x{height} at offset {offset} scale {scale} differs from the walk it \
                     replaced"
                );
            }
        }
    }
}

/// An outline that runs off the surface, so the walk's clamps against the
/// surface edge are exercised rather than merely inspected: a skip band
/// clipped on one side and a bounding rectangle clipped on another are where
/// an off-by-one in the pixel arithmetic would live.
#[test]
fn an_overhanging_outline_matches_the_walk_it_replaced() {
    let mut painted_somewhere = 0;
    for (x, y) in [
        (-30.0, -24.0),
        (-30.5, 40.25),
        (70.0, -24.0),
        (70.5, 40.25),
        (-30.0, 40.0),
    ] {
        let case = HighlightCase {
            name: "overhang",
            surface: (120, 90),
            origin: Point { x: 5.5, y: 6.5 },
            target: Rect {
                x,
                y,
                width: 90.0,
                height: 70.0,
            },
            scale: 1.0,
            opacity: 0.9,
        };

        let shipped_pixels = case.paint(shipped).pixels;
        painted_somewhere += shipped_pixels.iter().filter(|pixel| **pixel != 0).count();
        assert_eq!(
            shipped_pixels,
            case.paint(full_rectangle_reference).pixels,
            "an outline hanging off the surface at {x},{y} differs from the walk it replaced"
        );
    }
    assert!(
        painted_somewhere > 100,
        "every overhanging case fell entirely off the surface, so none of them proved anything"
    );
}
