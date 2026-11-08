use super::visibility::is_sentinel;
use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::Extents;
use crate::tree::properties::toolkit_trust::reports_global_position;

const ORIGIN_TOLERANCE: i64 = 1;

fn moved(rect: Extents, by: (i32, i32)) -> Option<Extents> {
    Some(Extents {
        x: rect.x.checked_add(by.0)?,
        y: rect.y.checked_add(by.1)?,
        width: rect.width,
        height: rect.height,
    })
}

/// The rectangle a pointer can be aimed at, in screen coordinates: the
/// toolkit's own for global-position toolkits, the window rectangle moved to
/// the client origin otherwise, and `None` when neither can be proved. The
/// screen extents of a toolkit that does not report them globally are never a
/// position: GTK 4 reads `[0, 0, w, h]` for nearly every node.
pub(crate) fn pointer_bounds(
    toolkit: &ToolkitId,
    screen: Extents,
    window: Extents,
    client_origin: Option<(i32, i32)>,
) -> Option<Extents> {
    if reports_global_position(toolkit) {
        return Some(screen);
    }
    if is_sentinel(window) {
        return None;
    }
    moved(window, client_origin?)
}

/// Whether the screen rectangle and the window rectangle describe the same
/// place once the window rectangle is moved to the client origin, to within
/// one pixel on each axis.
pub(crate) fn origins_agree(screen: Extents, window: Extents, client_origin: (i32, i32)) -> bool {
    let near = |screen: i32, window: i32, origin: i32| {
        (i64::from(screen) - i64::from(window) - i64::from(origin)).abs() <= ORIGIN_TOLERANCE
    };
    near(screen.x, window.x, client_origin.0) && near(screen.y, window.y, client_origin.1)
}

/// A target's rectangle in the pointer frame, and where the window sits in
/// that frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Calibrated {
    pub(crate) rect: Extents,
    pub(crate) window_origin: (i32, i32),
}

/// The geometry a hit test may rely on, or `None` when it cannot be proved.
/// A global-position toolkit is accepted only when its screen extents agree
/// with its window extents and the window's X11 client origin; any other
/// toolkit is accepted only as its window extents moved to the client origin.
pub(crate) fn calibrate(
    toolkit: &ToolkitId,
    screen: Extents,
    window: Extents,
    client_origin: Option<(i32, i32)>,
) -> Option<Calibrated> {
    let origin = client_origin?;
    if reports_global_position(toolkit) && !origins_agree(screen, window, origin) {
        return None;
    }
    let rect = pointer_bounds(toolkit, screen, window, Some(origin))?;
    let window_origin = if reports_global_position(toolkit) {
        (
            screen.x.checked_sub(window.x)?,
            screen.y.checked_sub(window.y)?,
        )
    } else {
        origin
    };
    Some(Calibrated {
        rect,
        window_origin,
    })
}

/// The point in window coordinates for a point in the pointer frame.
pub(crate) fn window_point(window_origin: (i32, i32), point: (i32, i32)) -> Option<(i32, i32)> {
    Some((
        point.0.checked_sub(window_origin.0)?,
        point.1.checked_sub(window_origin.1)?,
    ))
}

/// The popup's window-coordinate origin can be nonzero. Translate its local
/// root to its own X11 origin before placing an item in screen coordinates.
pub(crate) fn popup_origin(origin: (i32, i32), root: Extents) -> Option<(i32, i32)> {
    window_point((root.x, root.y), origin)
}

/// A rectangle in window coordinates moved into the pointer frame.
pub(crate) fn to_pointer_frame(window_origin: (i32, i32), rect: Extents) -> Option<Extents> {
    moved(rect, window_origin)
}

#[cfg(test)]
#[path = "frame_geometry_tests.rs"]
mod tests;
