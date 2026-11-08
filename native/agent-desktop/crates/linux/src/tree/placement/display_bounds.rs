use crate::tree::Extents;

fn overlaps(node: Extents, display: Extents) -> bool {
    let across = i64::from(node.x) < i64::from(display.x) + i64::from(display.width)
        && i64::from(node.x) + i64::from(node.width) > i64::from(display.x);
    let down = i64::from(node.y) < i64::from(display.y) + i64::from(display.height)
        && i64::from(node.y) + i64::from(node.height) > i64::from(display.y);
    across && down
}

/// Whether a rectangle of positive area in screen coordinates shares no area
/// with any display. Nothing read of either side is not evidence: a missing or
/// empty display list, a missing rectangle, a rectangle without area and the
/// `INT32_MIN` sentinel position all answer `false`.
pub(crate) fn off_every_display(node: Option<Extents>, displays: Option<&[Extents]>) -> bool {
    let (Some(node), Some(displays)) = (node, displays) else {
        return false;
    };
    let placed = node.width > 0 && node.height > 0 && node.x != i32::MIN && node.y != i32::MIN;
    placed && !displays.is_empty() && !displays.iter().any(|display| overlaps(node, *display))
}

#[cfg(test)]
#[path = "display_bounds_tests.rs"]
mod tests;
