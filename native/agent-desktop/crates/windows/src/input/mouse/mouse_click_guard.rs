//! Click delivery/release-guard state.
//!
//! Arms immediately before each mouse-down and disarms only after the
//! matching up posts; `Drop` is the sole place that posts a corrective up
//! when the sequence aborts mid-click. Cleanup is best-effort like every
//! other post here: `SendInput`'s return value is never treated as delivery
//! evidence (A9-3).

use crate::input::mouse::mouse_send::{button_input, post_mouse_inputs};
use crate::input::release_state::ReleaseState;

pub(crate) const CLICK_SUGGESTION: &str = "Inspect whether a mouse button may still be held before retrying; the emergency release was posted without an OS acknowledgement";

pub(crate) struct ClickReleaseGuard {
    up_flag: u32,
    state: ReleaseState,
}

impl ClickReleaseGuard {
    pub(crate) fn new(up_flag: u32) -> Self {
        Self {
            up_flag,
            state: ReleaseState::default(),
        }
    }

    pub(crate) fn arm(&mut self) {
        self.state.arm();
    }

    pub(crate) fn disarm(&mut self) {
        self.state.disarm();
    }

    pub(crate) fn should_release(&self) -> bool {
        self.state.should_release()
    }
}

impl Drop for ClickReleaseGuard {
    fn drop(&mut self) {
        if !self.should_release() {
            return;
        }
        post_mouse_inputs(&[button_input(self.up_flag)]);
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "mouse_click_guard_tests.rs"]
mod tests;
