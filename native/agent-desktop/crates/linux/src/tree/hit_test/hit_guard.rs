use crate::tree::Extents;

/// Whether a rectangle can be aimed at: both axes positive and no coordinate
/// at the `INT32_MIN` position a hidden GTK 3 widget reports.
pub(crate) fn aimable(rect: Extents) -> bool {
    rect.width > 0 && rect.height > 0 && rect.x != i32::MIN && rect.y != i32::MIN
}

/// Whether `point` lies in `rect` (half-open) and the rectangle is one a
/// pointer can reach. A zero axis, a negative size and the sentinel position
/// are values, not errors, and none of them can be hit.
pub(crate) fn admits(rect: Extents, point: (i32, i32)) -> bool {
    if !aimable(rect) {
        return false;
    }
    let inside = |origin: i32, extent: i32, at: i32| {
        i64::from(at) >= i64::from(origin) && i64::from(at) < i64::from(origin) + i64::from(extent)
    };
    inside(rect.x, rect.width, point.0) && inside(rect.y, rect.height, point.1)
}

/// The whole-pixel point a floating point one falls in, or `None` when it is
/// not finite or out of range.
pub(crate) fn pixel(x: f64, y: f64) -> Option<(i32, i32)> {
    let to_pixel = |value: f64| {
        let floor = value.floor();
        (floor.is_finite() && floor >= f64::from(i32::MIN) && floor <= f64::from(i32::MAX))
            .then_some(floor as i32)
    };
    Some((to_pixel(x)?, to_pixel(y)?))
}

#[cfg(test)]
#[path = "hit_guard_tests.rs"]
mod tests;
