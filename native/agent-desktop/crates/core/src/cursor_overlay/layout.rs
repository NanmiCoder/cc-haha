use crate::{Point, Rect};

/// How close, in points, two cursor positions are to count as the same place.
pub const CURSOR_SAME_POINT: f64 = 1.5;

/// How far the label sits right of and below the point the cursor targets,
/// which clears the dart drawn below and right of its tip.
const LABEL_OFFSET_X: f64 = 20.0;
const LABEL_OFFSET_Y: f64 = 30.0;

pub fn place_label(destination: &Point, size: (f64, f64), screen: &Rect) -> Rect {
    let (width, height) = size;
    let right = screen.x + screen.width;
    let bottom = screen.y + screen.height;
    let preferred_x = destination.x + LABEL_OFFSET_X;
    let preferred_y = destination.y + LABEL_OFFSET_Y;
    let x = if preferred_x + width <= right {
        preferred_x
    } else {
        destination.x - width - LABEL_OFFSET_X
    };
    let y = if preferred_y + height <= bottom {
        preferred_y
    } else {
        destination.y - height - LABEL_OFFSET_Y
    };
    Rect {
        x: x.clamp(screen.x, (right - width).max(screen.x)),
        y: y.clamp(screen.y, (bottom - height).max(screen.y)),
        width: width.min(screen.width.max(0.0)),
        height: height.min(screen.height.max(0.0)),
    }
}
