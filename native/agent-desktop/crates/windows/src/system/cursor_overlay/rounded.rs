//! The two rounded rectangles the overlay draws: the outline around the
//! element being acted on, and the pill the label's text sits on.
//!
//! They share a shape and a hazard. Both are composited per-pixel for the
//! reason `raster` exists — GDI leaves the alpha byte at zero and forcing
//! alpha across a bounding rectangle would square off the corners these are
//! defined by — and both are described as a rounded rectangle minus a smaller
//! one inset by their border.
//!
//! The highlight is the hollow one, and hollowness is what makes it the
//! expensive one: its bounding rectangle is the element the caller clicked,
//! so outlining a scroll container spans a hundred times the area of a
//! button's outline while painting no more of it. That is why it names the
//! interior it will not paint rather than testing every pixel of it.

use agent_desktop_core::Rect;

use super::geometry;
use super::raster::{self, Paint, Surface, SurfaceMapping};

/// The outline around the element being acted on, at the opacity its own
/// curve reports.
pub(crate) fn draw_highlight(
    surface: &mut Surface,
    mapping: &SurfaceMapping,
    target: &Rect,
    opacity: f64,
    accent: [f64; 3],
) {
    if opacity <= 0.0 {
        return;
    }
    let scale = mapping.scale;
    let outer = mapping.to_local(&geometry::highlight_rect(target, scale));
    let radius = geometry::HIGHLIGHT_CORNER_RADIUS * scale;
    let border = geometry::HIGHLIGHT_BORDER_WIDTH * scale;
    let inner = Rect {
        x: outer.x + border,
        y: outer.y + border,
        width: (outer.width - border * 2.0).max(0.0),
        height: (outer.height - border * 2.0).max(0.0),
    };
    raster::fill_region_outside(
        surface,
        &outer,
        &hollow_interior(&outer, border, radius),
        &Paint {
            rgb: accent,
            alpha: opacity,
        },
        |x, y| {
            in_rounded_rect(&outer, radius, x, y)
                && !in_rounded_rect(&inner, (radius - border).max(0.0), x, y)
        },
    );
}

/// The part of the outline's bounding rectangle the outline cannot reach.
///
/// The ring lies between `outer` and `inner`, so everything inside `inner` is
/// unpaintable, and the useful question is how much of `inner` a rectangle
/// can claim. The answer is not square: away from the corners the ring is
/// only `border` wide, and it bends inward by the corner radius solely at the
/// four corners - which sit entirely within the full-width bands this leaves
/// above and below. So the ends are held back by `border + radius` and the
/// sides by nothing but the border, and outlining a wide element walks two
/// thin columns per row instead of two thick ones.
///
/// Both insets carry a further `border` of slack over the boundary they have
/// to clear, so this is a fact about the shape rather than a claim about
/// floating point. Where the element is too small for `inner` to have a
/// corner radius that large, one extent or the other comes back negative,
/// which encloses nothing - so a degenerate target paints through the same
/// walk as every other.
fn hollow_interior(outer: &Rect, border: f64, radius: f64) -> Rect {
    let sides = border * 2.0;
    let ends = border + radius;
    Rect {
        x: outer.x + sides,
        y: outer.y + ends,
        width: outer.width - sides * 2.0,
        height: outer.height - ends * 2.0,
    }
}

/// The label pill: a soft shadow, then an opaque black, fully rounded body,
/// drawn per-pixel so its ends keep their coverage. GDI writes the text on
/// top, so the body has to be opaque wherever the text can land.
pub(crate) fn draw_label_pill(surface: &mut Surface, rect: &Rect, scale: f64) {
    let radius = rect.height / 2.0;
    let offset = agent_desktop_core::LABEL_SHADOW_OFFSET * scale;
    let blur = (agent_desktop_core::LABEL_SHADOW_BLUR * scale).max(0.5);
    let shadow = Rect {
        y: rect.y + offset,
        ..*rect
    };
    fill_graded(
        surface,
        &geometry::label_shadow_rect(rect, scale),
        &Paint {
            rgb: [0.0, 0.0, 0.0],
            alpha: agent_desktop_core::LABEL_SHADOW_OPACITY,
        },
        |x, y| shadow_strength(rounded_rect_distance(&shadow, radius, x, y), blur),
    );
    let body = *rect;
    raster::fill_region(
        surface,
        &body,
        &Paint {
            rgb: [0.0, 0.0, 0.0],
            alpha: 1.0,
        },
        |x, y| in_rounded_rect(&body, radius, x, y),
    );
}

/// Paints `paint` across `bounds` at the opacity `strength` gives each pixel's
/// centre, for a soft edge such as a shadow, where coverage is a gradient
/// rather than a shape.
fn fill_graded(
    surface: &mut Surface,
    bounds: &Rect,
    paint: &Paint,
    strength: impl Fn(f64, f64) -> f64,
) {
    let x0 = bounds.x.floor().max(0.0) as i32;
    let y0 = bounds.y.floor().max(0.0) as i32;
    let x1 = (bounds.x + bounds.width)
        .ceil()
        .min(f64::from(surface.width)) as i32;
    let y1 = (bounds.y + bounds.height)
        .ceil()
        .min(f64::from(surface.height)) as i32;
    for y in y0..y1 {
        for x in x0..x1 {
            let value = strength(f64::from(x) + 0.5, f64::from(y) + 0.5);
            surface.blend(x, y, paint, value);
        }
    }
}

/// How strongly a shadow covers a point `distance` outside its shape (negative
/// inside): full well inside, none a blur's width outside, easing between.
pub(super) fn shadow_strength(distance: f64, blur: f64) -> f64 {
    let t = ((distance + blur) / (blur * 2.0)).clamp(0.0, 1.0);
    1.0 - t * t * (3.0 - 2.0 * t)
}

/// The signed distance from a point to a rounded rectangle's edge: negative
/// inside, positive outside.
pub(super) fn rounded_rect_distance(rect: &Rect, radius: f64, x: f64, y: f64) -> f64 {
    let radius = radius.min(rect.width / 2.0).min(rect.height / 2.0).max(0.0);
    let half_width = rect.width / 2.0 - radius;
    let half_height = rect.height / 2.0 - radius;
    let dx = (x - (rect.x + rect.width / 2.0)).abs() - half_width;
    let dy = (y - (rect.y + rect.height / 2.0)).abs() - half_height;
    let outside = dx.max(0.0).hypot(dy.max(0.0));
    outside + dx.max(dy).min(0.0) - radius
}

pub(super) fn in_rounded_rect(rect: &Rect, radius: f64, x: f64, y: f64) -> bool {
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return false;
    }
    let radius = radius.min(rect.width / 2.0).min(rect.height / 2.0).max(0.0);
    let left = rect.x + radius;
    let right = rect.x + rect.width - radius;
    let top = rect.y + radius;
    let bottom = rect.y + rect.height - radius;
    if x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height {
        return false;
    }
    let nearest_x = x.clamp(left, right);
    let nearest_y = y.clamp(top, bottom);
    (x - nearest_x).hypot(y - nearest_y) <= radius
}

#[cfg(test)]
#[path = "rounded_tests.rs"]
mod tests;
