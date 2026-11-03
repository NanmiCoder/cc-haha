use crate::system::x11::stacking::stacked_window::StackedWindow;
use crate::system::x11::stacking::stacking_read::StackingRead;
use crate::system::x11::stacking::stacking_snapshot::StackingSnapshot;
use crate::system::x11::window::desktop_placement::DesktopPlacement;
use crate::tree::Extents;

/// Whether anything paints over a rectangle. `Unknown` is the absence of an
/// answer and is never read as `Clear`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cover {
    Clear,
    Covered,
    Unknown,
}

fn overlaps(left: Extents, right: Extents) -> bool {
    left.x < right.x.saturating_add(right.width)
        && right.x < left.x.saturating_add(left.width)
        && left.y < right.y.saturating_add(right.height)
        && right.y < left.y.saturating_add(left.height)
}

fn frame_of(window: &StackedWindow) -> Extents {
    let left = i32::try_from(window.extents.left).unwrap_or(0);
    let right = i32::try_from(window.extents.right).unwrap_or(0);
    let top = i32::try_from(window.extents.top).unwrap_or(0);
    let bottom = i32::try_from(window.extents.bottom).unwrap_or(0);
    Extents {
        x: window.client.x - left,
        y: window.client.y - top,
        width: window.client.width + left + right,
        height: window.client.height + top + bottom,
    }
}

/// Whether a managed window is painted now: mapped, not minimised and on the
/// current desktop or every desktop. `None` when its desktop is unknown.
fn is_shown(window: &StackedWindow, snapshot: &StackingSnapshot) -> Option<bool> {
    if window.flags.hidden || !window.flags.mapped {
        return Some(false);
    }
    match (window.desktop, snapshot.current_desktop) {
        (DesktopPlacement::Sticky, _) => Some(true),
        (DesktopPlacement::On(desktop), Some(current)) => Some(desktop == current),
        (DesktopPlacement::On(_), None) => Some(true),
        (DesktopPlacement::Unknown, _) => None,
    }
}

fn above_target(snapshot: &StackingSnapshot, target_client: u32) -> Option<&[StackedWindow]> {
    let position = snapshot
        .stack
        .iter()
        .position(|window| window.id == target_client)?;
    Some(&snapshot.stack[position + 1..])
}

/// Decides from the stacking snapshot whether any window above the target
/// overlaps `rect` by at least one pixel. A managed window counts when it is
/// mapped, not minimised and on the current desktop or every desktop; a mapped
/// override-redirect window above the target always counts. A window above
/// whose desktop is unknown, or a target the snapshot does not list, leaves the
/// answer unknown unless another window already covers.
pub(crate) fn cover(read: &StackingRead, target_client: u32, rect: Extents) -> Cover {
    let StackingRead::Ready(snapshot) = read else {
        return Cover::Unknown;
    };
    let Some(above) = above_target(snapshot, target_client) else {
        return Cover::Unknown;
    };
    if snapshot
        .override_redirect_above
        .iter()
        .any(|window| overlaps(*window, rect))
    {
        return Cover::Covered;
    }
    let mut unknown = false;
    for window in above {
        if !overlaps(frame_of(window), rect) {
            continue;
        }
        match is_shown(window, snapshot) {
            Some(true) => return Cover::Covered,
            None => unknown = true,
            Some(false) => {}
        }
    }
    if unknown {
        Cover::Unknown
    } else {
        Cover::Clear
    }
}

#[cfg(test)]
#[path = "window_obstruction_tests.rs"]
mod tests;
