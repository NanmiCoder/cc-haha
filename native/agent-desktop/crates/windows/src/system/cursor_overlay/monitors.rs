//! Which monitor a point belongs to, and where the overlay rests.
//!
//! Pure functions over a supplied monitor list, which is the whole point:
//! A29-6 records this host as one monitor at one scale, so a mixed-DPI or
//! multi-monitor arrangement cannot be observed here. Keeping the selection
//! free of Win32 is what lets a test present an arrangement the desktop
//! cannot.
//!
//! Points arrive in physical pixels, because the CLI and the renderer are both
//! per-monitor DPI aware, so the overlay draws at them without scaling.
//!
//! The list is crate-local rather than core's `DisplayInfo`, and that is a
//! decision rather than an oversight. `DisplayInfo` carries id, bounds,
//! primary and scale and no work area, and the overlay needs the work area to
//! place a label and to pick a resting point. Extending it would change
//! `list-displays` output on both platforms, which is a wider change than the
//! overlay needs.

use agent_desktop_core::{Point, Rect};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct OverlayMonitor {
    pub(crate) bounds: Rect,
    pub(crate) work_area: Rect,
    pub(crate) scale: f64,
    pub(crate) is_primary: bool,
}

/// The monitor a point falls on, or the nearest one when it falls in the gap
/// between two non-adjacent monitors. Nearest is by squared distance to the
/// monitor's centre, which is deterministic for a tie rather than dependent
/// on enumeration order.
pub(crate) fn monitor_for_point<'a>(
    monitors: &'a [OverlayMonitor],
    point: &Point,
) -> Option<&'a OverlayMonitor> {
    if monitors.is_empty() {
        return None;
    }
    if let Some(containing) = monitors
        .iter()
        .find(|monitor| contains(&monitor.bounds, point))
    {
        return Some(containing);
    }
    monitors.iter().min_by(|left, right| {
        distance_to_centre(&left.bounds, point)
            .partial_cmp(&distance_to_centre(&right.bounds, point))
            .unwrap_or(std::cmp::Ordering::Equal)
    })
}

/// The primary monitor's work-area midpoint, where the cursor rests before
/// any action has placed it.
pub(crate) fn resting_point(monitors: &[OverlayMonitor]) -> Option<Point> {
    let primary = monitors
        .iter()
        .find(|monitor| monitor.is_primary)
        .or_else(|| monitors.first())?;
    Some(Point {
        x: primary.work_area.x + primary.work_area.width / 2.0,
        y: primary.work_area.y + primary.work_area.height / 2.0,
    })
}

fn contains(bounds: &Rect, point: &Point) -> bool {
    point.x >= bounds.x
        && point.x < bounds.x + bounds.width
        && point.y >= bounds.y
        && point.y < bounds.y + bounds.height
}

fn distance_to_centre(bounds: &Rect, point: &Point) -> f64 {
    let dx = point.x - (bounds.x + bounds.width / 2.0);
    let dy = point.y - (bounds.y + bounds.height / 2.0);
    dx * dx + dy * dy
}

#[cfg(test)]
#[path = "monitors_tests.rs"]
mod tests;
