use agent_desktop_core::Rect;

use crate::tree::Extents;

const FRAME_TOLERANCE: f64 = 0.01;
const CLIENT_TOLERANCE: f64 = 0.02;

/// Which drawable of a window a capture takes: the window manager's frame, the
/// client alone, or neither because no size agrees with the reported bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unit {
    Frame,
    Client,
    Unproven,
}

fn agrees(size: Extents, bounds: Rect, tolerance: f64) -> bool {
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return false;
    }
    let width = (f64::from(size.width) / bounds.width - 1.0).abs();
    let height = (f64::from(size.height) / bounds.height - 1.0).abs();
    width <= tolerance && height <= tolerance
}

/// The frame when its size passes the strict ratio check against the bounds,
/// else the client when it passes the check the debug capture applies, else
/// `Unproven`.
pub(crate) fn choose(client: Extents, frame: Option<Extents>, bounds: Option<Rect>) -> Unit {
    let Some(bounds) = bounds else {
        return Unit::Unproven;
    };
    if frame.is_some_and(|size| agrees(size, bounds, FRAME_TOLERANCE)) {
        return Unit::Frame;
    }
    if agrees(client, bounds, CLIENT_TOLERANCE) {
        return Unit::Client;
    }
    Unit::Unproven
}

#[cfg(test)]
#[path = "window_unit_tests.rs"]
mod tests;
