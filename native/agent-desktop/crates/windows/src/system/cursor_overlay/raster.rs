//! The overlay's pixels, composited by hand into a premultiplied buffer.
//!
//! Every GDI raster primitive — `Ellipse`, `Polygon`, `FillRect`, `DrawTextW`
//! alike — writes RGB into a 32bpp DIB and leaves the alpha byte at zero, so
//! anything drawn through GDI is invisible under `ULW_ALPHA`. Forcing alpha
//! across a rectangle afterwards rescues an opaque rectangle and nothing
//! else: an anti-aliased edge and a soft ring need per-pixel coverage, which
//! is the very thing being destroyed.
//!
//! So every shape the overlay draws is composited here instead, with coverage
//! computed rather than approximated: the surface, the coverage walk and the
//! blend live in this module, the glyph and the ripple with them, and the two
//! rounded rectangles in `rounded` alongside. GDI draws only the label text,
//! onto a bubble body that has already been made opaque - and even there the
//! alpha byte is written directly as the glyphs are copied back, rather than
//! forced across a rectangle afterwards, so the bubble's rounded corners are
//! never in reach of it.
//!
//! Being pure is the other half of the point: the alpha behaviour that makes
//! this necessary is assertable without a window.

use agent_desktop_core::{Point, Rect};

use super::geometry;

/// A premultiplied 32bpp BGRA surface, top-down, ready for
/// `UpdateLayeredWindow`.
pub(crate) struct Surface {
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) pixels: Vec<u32>,
}

/// shortcut: 16,777,216 pixels, raise only after measuring allocation and frame cost on supported displays.
const MAX_SURFACE_PIXELS: usize = 16_777_216;

#[derive(Clone, Copy)]
pub(super) struct Paint {
    pub(super) rgb: [f64; 3],
    pub(super) alpha: f64,
}

impl Surface {
    pub(crate) fn try_transparent(width: i32, height: i32) -> Option<Self> {
        let (width, height) = (usize::try_from(width).ok()?, usize::try_from(height).ok()?);
        let count = width.checked_mul(height)?;
        if count > MAX_SURFACE_PIXELS {
            return None;
        }
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(count).ok()?;
        pixels.resize(count, 0);
        Some(Self {
            width: i32::try_from(width).ok()?,
            height: i32::try_from(height).ok()?,
            pixels,
        })
    }

    pub(crate) fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn alpha_at(&self, x: i32, y: i32) -> u8 {
        self.pixel_at(x, y).map_or(0, |value| (value >> 24) as u8)
    }

    pub(crate) fn pixel_at(&self, x: i32, y: i32) -> Option<u32> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return None;
        }
        self.pixels
            .get((y as usize) * (self.width as usize) + (x as usize))
            .copied()
    }

    /// Composites one sample over what is already there, premultiplied.
    pub(super) fn blend(&mut self, x: i32, y: i32, paint: &Paint, coverage: f64) {
        if coverage <= 0.0 || x < 0 || y < 0 || x >= self.width || y >= self.height {
            return;
        }
        let index = (y as usize) * (self.width as usize) + (x as usize);
        let Some(existing) = self.pixels.get(index).copied() else {
            return;
        };
        let source_alpha = (paint.alpha * coverage).clamp(0.0, 1.0);
        if source_alpha <= 0.0 {
            return;
        }
        let existing_alpha = f64::from((existing >> 24) as u8) / 255.0;
        let out_alpha = source_alpha + existing_alpha * (1.0 - source_alpha);
        let channel = |shift: u32, source: f64| {
            let under = f64::from(((existing >> shift) & 0xFF) as u8) / 255.0;
            let over = source * source_alpha + under * (1.0 - source_alpha);
            (over.clamp(0.0, 1.0) * 255.0).round() as u32
        };
        let blue = channel(0, paint.rgb[2]);
        let green = channel(8, paint.rgb[1]);
        let red = channel(16, paint.rgb[0]);
        let alpha = (out_alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
        self.pixels[index] = (alpha << 24) | (red << 16) | (green << 8) | blue;
    }
}

/// How many samples per axis each pixel is tested with. Three is enough for
/// an edge that reads smooth at these sizes and cheap enough to stay well
/// inside a frame.
const SAMPLES: i32 = 3;

/// A pixel that its own corners and centre all agree about is not on an
/// edge, so its coverage is already known and the sampling grid would spend
/// SAMPLES x SAMPLES polygon walks confirming it.
///
/// This matters because the interior of a shape dwarfs its outline: the
/// probe of the busiest frame spent most of a display frame supersampling
/// pixels that were never in doubt. The early-out is exact for a convex
/// region - four corners inside means the pixel is inside - and the centre
/// is sampled with them so a thin ring passing between the corners is still
/// treated as an edge. A feature thinner than a pixel could still slip
/// between all five, which is why the ring widths here are kept above one
/// pixel at the smallest style size the CLI accepts.
fn coverage(x: i32, y: i32, inside: impl Fn(f64, f64) -> bool) -> f64 {
    let left = f64::from(x);
    let top = f64::from(y);
    let first = inside(left, top);
    let undecided = [
        (left + 1.0, top),
        (left, top + 1.0),
        (left + 1.0, top + 1.0),
        (left + 0.5, top + 0.5),
    ]
    .iter()
    .any(|(px, py)| inside(*px, *py) != first);
    if !undecided {
        return if first { 1.0 } else { 0.0 };
    }

    let mut hits = 0;
    for sy in 0..SAMPLES {
        for sx in 0..SAMPLES {
            let px = left + (f64::from(sx) + 0.5) / f64::from(SAMPLES);
            let py = top + (f64::from(sy) + 0.5) / f64::from(SAMPLES);
            if inside(px, py) {
                hits += 1;
            }
        }
    }
    f64::from(hits) / f64::from(SAMPLES * SAMPLES)
}

/// A skip rectangle that excludes nothing, for the shapes that are solid
/// rather than hollow. Its negative extent cannot enclose any pixel's cell.
const NOTHING_SKIPPED: Rect = Rect {
    x: 0.0,
    y: 0.0,
    width: -1.0,
    height: -1.0,
};

pub(super) fn fill_region(
    surface: &mut Surface,
    bounds: &Rect,
    paint: &Paint,
    inside: impl Fn(f64, f64) -> bool,
) {
    fill_region_outside(surface, bounds, &NOTHING_SKIPPED, paint, inside);
}

/// The same walk, with a rectangle the caller has established the predicate
/// is false across left unvisited.
///
/// A hollow shape is the reason this exists. An outline's bounding rectangle
/// is almost entirely interior, and testing that interior costs a coverage
/// probe per pixel to learn it is empty - which grows with the area of the
/// element being outlined rather than with the outline, so a large panel's
/// highlight overran a whole display frame while a button's did not.
///
/// `skip` is honoured per pixel rather than per rectangle so no pixel is
/// visited twice: painting the border as four overlapping strips would blend
/// the corners a second time, and blending is not idempotent. A pixel is
/// dropped only when its whole cell lies inside `skip`, where the predicate
/// is false at every sample, so `coverage` would return zero and `blend`
/// would do nothing. Skipping it is therefore the same bytes, not an
/// approximation of them.
pub(super) fn fill_region_outside(
    surface: &mut Surface,
    bounds: &Rect,
    skip: &Rect,
    paint: &Paint,
    inside: impl Fn(f64, f64) -> bool,
) {
    let x0 = bounds.x.floor().max(0.0) as i32;
    let y0 = bounds.y.floor().max(0.0) as i32;
    let x1 = (bounds.x + bounds.width)
        .ceil()
        .min(f64::from(surface.width)) as i32;
    let y1 = (bounds.y + bounds.height)
        .ceil()
        .min(f64::from(surface.height)) as i32;
    let skip_x0 = skip.x.ceil().max(f64::from(x0)) as i32;
    let skip_x1 = (skip.x + skip.width).floor().min(f64::from(x1)) as i32;
    let skip_y0 = skip.y.ceil().max(f64::from(y0)) as i32;
    let skip_y1 = (skip.y + skip.height).floor().min(f64::from(y1)) as i32;
    let hollow = skip_x0 < skip_x1 && skip_y0 < skip_y1;
    for y in y0..y1 {
        if hollow && y >= skip_y0 && y < skip_y1 {
            for x in (x0..skip_x0).chain(skip_x1..x1) {
                let value = coverage(x, y, &inside);
                surface.blend(x, y, paint, value);
            }
        } else {
            for x in x0..x1 {
                let value = coverage(x, y, &inside);
                surface.blend(x, y, paint, value);
            }
        }
    }
}

fn point_in_polygon(points: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut inside = false;
    let mut j = points.len() - 1;
    for i in 0..points.len() {
        let (xi, yi) = points[i];
        let (xj, yj) = points[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn distance_to_polygon(points: &[(f64, f64)], x: f64, y: f64) -> f64 {
    let mut best = f64::MAX;
    let mut j = points.len() - 1;
    for i in 0..points.len() {
        best = best.min(distance_to_segment(points[j], points[i], x, y));
        j = i;
    }
    best
}

fn distance_to_segment(a: (f64, f64), b: (f64, f64), x: f64, y: f64) -> f64 {
    let (ax, ay) = a;
    let (bx, by) = b;
    let dx = bx - ax;
    let dy = by - ay;
    let length_squared = dx * dx + dy * dy;
    let t = if length_squared <= f64::EPSILON {
        0.0
    } else {
        (((x - ax) * dx + (y - ay) * dy) / length_squared).clamp(0.0, 1.0)
    };
    (x - (ax + t * dx)).hypot(y - (ay + t * dy))
}

/// How screen coordinates land on the surface: where the surface's top-left
/// sits in screen space, and the size the session's style asks every shape to
/// be drawn at.
///
/// Every primitive takes both and neither is meaningful alone - a scale
/// without the origin draws the right shape in the wrong place - so they
/// travel together rather than as two more arguments each.
#[derive(Clone)]
pub(crate) struct SurfaceMapping {
    pub(crate) origin: Point,
    pub(crate) scale: f64,
}

impl SurfaceMapping {
    /// A screen-space rectangle in surface coordinates.
    pub(super) fn to_local(&self, rect: &Rect) -> Rect {
        Rect {
            x: rect.x - self.origin.x,
            y: rect.y - self.origin.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

/// The cursor glyph: a rimmed dart, its tip on the pose point.
pub(crate) fn draw_glyph(
    surface: &mut Surface,
    mapping: &SurfaceMapping,
    tip: &Point,
    fill: [f64; 3],
    rim: [f64; 3],
) {
    let scale = mapping.scale;
    let rect = mapping.to_local(&geometry::glyph_rect(tip, scale));
    let points: Vec<(f64, f64)> = geometry::DART
        .iter()
        .map(|(x, y)| (rect.x + x * scale, rect.y + y * scale))
        .collect();
    let local = Rect {
        x: rect.x - geometry::GLYPH_RIM_WIDTH * scale,
        y: rect.y - geometry::GLYPH_RIM_WIDTH * scale,
        width: rect.width + geometry::GLYPH_RIM_WIDTH * scale * 2.0,
        height: rect.height + geometry::GLYPH_RIM_WIDTH * scale * 2.0,
    };
    let rim_width = geometry::GLYPH_RIM_WIDTH * scale * 0.5;

    let rim_points = &points;
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: rim,
            alpha: 1.0,
        },
        |x, y| {
            point_in_polygon(rim_points, x, y) || distance_to_polygon(rim_points, x, y) <= rim_width
        },
    );
    let fill_points = points;
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: fill,
            alpha: 1.0,
        },
        |x, y| point_in_polygon(&fill_points, x, y),
    );
}

/// The click ripple: a solid centre and an expanding ring, both fading as the
/// ripple's phase advances.
pub(crate) fn draw_ripple(
    surface: &mut Surface,
    mapping: &SurfaceMapping,
    tip: &Point,
    phase: f64,
    accent: [f64; 3],
) {
    if phase <= 0.0 || phase > 1.0 {
        return;
    }
    let scale = mapping.scale;
    let local = mapping.to_local(&geometry::ripple_rect(tip, scale));
    let centre_x = local.x + local.width / 2.0;
    let centre_y = local.y + local.height / 2.0;
    let fade = 1.0 - phase;

    let core = geometry::RIPPLE_CORE_RADIUS * scale * (1.0 - phase * 0.4);
    fill_region(
        surface,
        &local,
        &Paint {
            rgb: accent,
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
            rgb: accent,
            alpha: 0.85 * fade,
        },
        |x, y| {
            let distance = (x - centre_x).hypot(y - centre_y);
            distance <= ring && distance >= ring - thickness
        },
    );
}

#[cfg(test)]
#[path = "raster_tests.rs"]
mod tests;
