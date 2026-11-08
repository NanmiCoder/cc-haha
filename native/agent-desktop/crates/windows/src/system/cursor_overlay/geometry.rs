//! Product cursor geometry in top-down screen coordinates.

use agent_desktop_core::{Point, Rect};

pub(crate) const GLYPH_WIDTH: f64 = agent_desktop_core::PRODUCT_CURSOR_WIDTH;
pub(crate) const GLYPH_HEIGHT: f64 = agent_desktop_core::PRODUCT_CURSOR_HEIGHT;
pub(crate) const GLYPH_RIM_WIDTH: f64 = agent_desktop_core::PRODUCT_CURSOR_OUTLINE;
pub(crate) const DART: [(f64, f64); 7] = agent_desktop_core::PRODUCT_CURSOR_ARROW;

/// The ripple's full extent, and the solid disc at its centre.
pub(crate) const RIPPLE_SIZE: f64 = 64.0;
pub(crate) const RIPPLE_CORE_RADIUS: f64 = 8.0;
pub(crate) const RIPPLE_RING_INSET: f64 = 4.0;

/// The highlight drawn around the element being acted on.
pub(crate) const HIGHLIGHT_BORDER_WIDTH: f64 = 2.5;
pub(crate) const HIGHLIGHT_CORNER_RADIUS: f64 = 8.0;
pub(crate) const HIGHLIGHT_PADDING: f64 = 5.0;

/// The glyph's rectangle for a pose, with the dart's tip at the pose point.
pub(crate) fn glyph_rect(tip: &Point, scale: f64) -> Rect {
    let (tip_x, tip_y) = DART[0];
    Rect {
        x: tip.x - tip_x * scale,
        y: tip.y - tip_y * scale,
        width: GLYPH_WIDTH * scale,
        height: GLYPH_HEIGHT * scale,
    }
}

/// The ripple's rectangle for a pose, centred on the pose point.
pub(crate) fn ripple_rect(tip: &Point, scale: f64) -> Rect {
    let size = RIPPLE_SIZE * scale;
    Rect {
        x: tip.x - size / 2.0,
        y: tip.y - size / 2.0,
        width: size,
        height: size,
    }
}

/// The label pill's shadow extent: the pill's rectangle moved down by the
/// shadow's offset and grown by its blur on every side, so the follower
/// surface and the card's fade both cover the whole shadow.
pub(crate) fn label_shadow_rect(pill: &Rect, scale: f64) -> Rect {
    let blur = agent_desktop_core::LABEL_SHADOW_BLUR * scale * 2.0;
    Rect {
        x: pill.x - blur,
        y: pill.y + agent_desktop_core::LABEL_SHADOW_OFFSET * scale - blur,
        width: pill.width + blur * 2.0,
        height: pill.height + blur * 2.0,
    }
}

/// The highlight's rectangle: the target's bounds, padded, so the outline
/// sits outside the element rather than over its edge.
pub(crate) fn highlight_rect(target: &Rect, scale: f64) -> Rect {
    let padding = HIGHLIGHT_PADDING * scale;
    Rect {
        x: target.x - padding,
        y: target.y - padding,
        width: target.width + padding * 2.0,
        height: target.height + padding * 2.0,
    }
}

/// The one surface the renderer paints, sized to contain everything this
/// frame draws.
///
/// A surface that spanned the virtual screen would cost a frame budget rather
/// than a rounding error on a large desktop — measured near-linear in pixel
/// count — so the window follows the pose instead, and has to be big enough
/// for the ripple at full extent or the effect would be clipped at its edges.
pub(crate) fn follower_rect(
    tip: &Point,
    scale: f64,
    label: Option<&Rect>,
    highlight: Option<&Rect>,
) -> Rect {
    let mut union = union_of(&glyph_rect(tip, scale), &ripple_rect(tip, scale));
    if let Some(label) = label {
        union = union_of(&union, label);
    }
    if let Some(highlight) = highlight {
        union = union_of(&union, highlight);
    }
    union
}

pub(crate) fn union_of(left: &Rect, right: &Rect) -> Rect {
    let x = left.x.min(right.x);
    let y = left.y.min(right.y);
    let right_edge = (left.x + left.width).max(right.x + right.width);
    let bottom_edge = (left.y + left.height).max(right.y + right.height);
    Rect {
        x,
        y,
        width: right_edge - x,
        height: bottom_edge - y,
    }
}

#[cfg(test)]
#[path = "geometry_tests.rs"]
mod tests;
