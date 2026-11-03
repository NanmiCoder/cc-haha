use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::display::grab_rect;
use super::window_context::grab_failure;
use crate::system::capture::capture_env::CaptureEnv;
use crate::system::x11::capture::grab::Raw;
use crate::tree::Extents;

/// The drawable id a grab names to mean the screen's root window.
pub(crate) const ROOT_DRAWABLE: u32 = 0;

pub(crate) fn paint(
    env: &CaptureEnv,
    compositing: bool,
    area: Extents,
    deadline: Deadline,
) -> Result<Raw, AdapterError> {
    if compositing {
        return Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The screen cannot be captured truthfully under a compositing window manager: \
             the root window holds only the manager's own stage, not the application windows",
        )
        .with_suggestion("Capture one window with 'screenshot --window-id'")
        .with_details(serde_json::json!({ "reason": "compositing" })));
    }

    env.grabber
        .grab(ROOT_DRAWABLE, grab_rect(area)?, deadline)
        .map_err(|error| grab_failure(error, deadline))
}

#[cfg(test)]
#[path = "fullscreen_route_tests.rs"]
mod tests;
