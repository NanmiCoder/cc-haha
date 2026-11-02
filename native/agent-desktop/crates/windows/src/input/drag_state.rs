//! Drag delivery/release-guard state.
//!
//! A `MouseInputEvent` batch is plain data - unlike macOS's `CGEvent`-backed
//! guard, constructing the corrective batch here cannot fail. The guard
//! arms immediately before the first committed injection (mouse-down) and
//! disarms only after the final release posts; its `Drop` is the sole place
//! that posts corrective input, and it always targets the **origin**, never
//! the destination.
//! Cleanup is best-effort like every other post here: `SendInput`'s return
//! value is never treated as delivery evidence (A9-3), so an abort reports
//! `emergency_release_posted` without claiming the OS acknowledged it.

use agent_desktop_core::AdapterError;

use crate::input::mouse::mouse_coord::NormalizedPoint;
use crate::input::mouse::mouse_send::{
    MOUSEEVENTF_LEFTUP, button_input, move_input, post_mouse_inputs,
};
use crate::input::release_state::ReleaseState;

const SUGGESTION: &str = "Inspect the source and destination before retrying; the emergency release was posted without an OS acknowledgement";

pub(crate) struct DragReleaseGuard {
    origin: NormalizedPoint,
    state: ReleaseState,
}

impl DragReleaseGuard {
    pub(crate) fn new(origin: NormalizedPoint) -> Self {
        Self {
            origin,
            state: ReleaseState::default(),
        }
    }

    pub(crate) fn arm(&mut self) {
        self.state.arm();
    }

    pub(crate) fn disarm(&mut self) {
        self.state.disarm();
    }

    pub(crate) fn mark_delivered(&mut self) {
        self.state.mark_delivered();
    }

    pub(crate) fn should_release(&self) -> bool {
        self.state.should_release()
    }

    pub(crate) fn enrich_error(&self, error: AdapterError) -> AdapterError {
        self.state.enrich_error(error, SUGGESTION)
    }
}

impl Drop for DragReleaseGuard {
    fn drop(&mut self) {
        if !self.should_release() {
            return;
        }
        post_mouse_inputs(&[move_input(self.origin), button_input(MOUSEEVENTF_LEFTUP)]);
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "drag_state_tests.rs"]
mod tests;
