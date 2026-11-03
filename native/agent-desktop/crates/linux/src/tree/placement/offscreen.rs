use crate::tree::Extents;
use crate::tree::hit_test::hit_guard::aimable;

/// Geometry this close to an edge is inconclusive.
pub(crate) const EDGE_SLACK: i32 = 24;

/// Everything the offscreen rule reads about one node. Every rectangle is in
/// window coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OffscreenInput {
    pub(crate) node: Option<Extents>,
    pub(crate) frame: Option<Extents>,
    pub(crate) container: Option<Extents>,
    pub(crate) visible: bool,
    pub(crate) showing: bool,
    pub(crate) sentinel: bool,
    pub(crate) minimized: Option<bool>,
}

fn usable(rect: Option<Extents>) -> Option<Extents> {
    rect.filter(|rect| aimable(*rect))
}

fn axis_gap(start: i32, length: i32, other_start: i32, other_length: i32) -> i64 {
    let end = i64::from(start) + i64::from(length);
    let other_end = i64::from(other_start) + i64::from(other_length);
    (i64::from(start) - other_end).max(i64::from(other_start) - end)
}

fn gap(node: Extents, around: Extents) -> i64 {
    let across = axis_gap(node.x, node.width, around.x, around.width);
    let down = axis_gap(node.y, node.height, around.y, around.height);
    across.max(down)
}

/// True means proven off screen; false means proven on screen. Unknown inputs
/// and near-edge gaps stay None.
pub(crate) fn offscreen(input: OffscreenInput) -> Option<bool> {
    if input.minimized == Some(true) {
        return Some(true);
    }
    if super::visibility::not_drawn(input.visible, input.showing, input.sentinel) {
        return Some(true);
    }
    let node = usable(input.node)?;
    let frame = usable(input.frame)?;
    let container = match input.container {
        Some(container) if super::visibility::is_sentinel(container) => None,
        Some(container) => Some(usable(Some(container))?),
        None => None,
    };
    let mut inside = true;
    for around in std::iter::once(frame).chain(container) {
        let distance = gap(node, around);
        if distance > i64::from(EDGE_SLACK) {
            return Some(true);
        }
        if distance >= 0 {
            inside = false;
        }
    }
    (inside && input.minimized == Some(false)).then_some(false)
}

#[cfg(test)]
#[path = "offscreen_tests.rs"]
mod tests;
