//! The cursor label's pill: a black, fully rounded tag that fits its text.
//!
//! Each renderer measures the label in its own system font and takes every
//! other dimension from here, so the macOS and Windows overlays draw the same
//! pill, with the text centred in it both ways.

use crate::Rect;

/// The label's type size at the default cursor size.
pub const LABEL_FONT_POINTS: f64 = 12.5;
/// The pill's height; its corner radius is half of it.
pub const LABEL_PILL_HEIGHT: f64 = 24.0;
/// Space between the text and each end of the pill.
pub const LABEL_PILL_PADDING: f64 = 10.0;
/// The widest the pill grows; longer text is cut short with an ellipsis.
pub const LABEL_PILL_MAX_WIDTH: f64 = 360.0;
/// The pill's shadow: black at this opacity, offset down and blurred.
pub const LABEL_SHADOW_OPACITY: f64 = 0.31;
pub const LABEL_SHADOW_OFFSET: f64 = 2.0;
pub const LABEL_SHADOW_BLUR: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LabelPill {
    width: f64,
    height: f64,
    text_width: f64,
}

impl LabelPill {
    /// The pill for `label`, whose text measures `text_width` when set at
    /// [`LABEL_FONT_POINTS`] times `scale`. `None` when the label says
    /// nothing, so an empty label shows no pill.
    pub fn for_label(label: &str, text_width: f64, scale: f64) -> Option<Self> {
        if label.trim().is_empty() || !text_width.is_finite() || !scale.is_finite() || scale <= 0.0
        {
            return None;
        }
        let padding = LABEL_PILL_PADDING * scale;
        let widest_text = LABEL_PILL_MAX_WIDTH * scale - padding * 2.0;
        let text_width = text_width.clamp(0.0, widest_text);
        Some(Self {
            width: text_width + padding * 2.0,
            height: LABEL_PILL_HEIGHT * scale,
            text_width,
        })
    }

    pub const fn size(&self) -> (f64, f64) {
        (self.width, self.height)
    }

    pub fn corner_radius(&self) -> f64 {
        self.height / 2.0
    }

    /// The pill cut down to at most `width`, as placing it on a narrow screen
    /// does. It keeps its padding, so the text gets what is left and is cut
    /// short with an ellipsis rather than running past the pill's ends.
    pub fn within(self, width: f64) -> Self {
        if width.is_nan() || width >= self.width {
            return self;
        }
        let padding = (self.width - self.text_width) / 2.0;
        let width = width.max(padding * 2.0);
        Self {
            width,
            text_width: width - padding * 2.0,
            ..self
        }
    }

    /// Where a line of text `line_height` tall sits inside the pill, relative
    /// to its top-left corner: centred across and down.
    pub fn text_frame(&self, line_height: f64) -> Rect {
        Rect {
            x: (self.width - self.text_width) / 2.0,
            y: (self.height - line_height) / 2.0,
            width: self.text_width,
            height: line_height,
        }
    }
}

#[cfg(test)]
#[path = "label_pill_tests.rs"]
mod tests;
