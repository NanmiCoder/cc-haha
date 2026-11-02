//! The agent's text caret: a thin bar in the accent colour where the app is
//! inserting text, in a layered window of its own so it can sit in a text
//! field far from wherever the cursor rests. It marks the field the cursor
//! was typing in, so it goes when the cursor sets off for somewhere else.

#[cfg(target_os = "windows")]
pub(crate) use imp::CaretMark;

use agent_desktop_core::{CURSOR_SAME_POINT, Point};

/// Whether moving the cursor from `from` to `to` leaves the place it was:
/// [`CURSOR_SAME_POINT`] or more away, the way the macOS renderer decides.
pub(crate) fn leaves(from: &Point, to: &Point) -> bool {
    (to.x - from.x).hypot(to.y - from.y) >= CURSOR_SAME_POINT
}

#[cfg(test)]
#[path = "caret_mark_tests.rs"]
mod tests;

#[cfg(target_os = "windows")]
mod imp {
    use agent_desktop_core::{AdapterError, Rect};

    use crate::system::cursor_overlay::window::OverlayWindow;

    pub(crate) struct CaretMark {
        window: OverlayWindow,
        shown: std::cell::Cell<bool>,
    }

    impl CaretMark {
        pub(crate) fn create() -> Result<Self, AdapterError> {
            Ok(Self {
                window: OverlayWindow::create()?,
                shown: std::cell::Cell::new(false),
            })
        }

        /// Draws the caret over `at`. With `follow`, only a caret already
        /// showing moves, and no `at` hides it.
        pub(crate) fn place(&self, at: Option<&Rect>, accent: [f64; 3], follow: bool) {
            if follow && !self.shown.get() {
                return;
            }
            match at {
                Some(at) => self.show(at, accent),
                None if follow => self.hide(),
                None => {}
            }
        }

        /// Draws the caret over `at`. The CLI and the renderer are both
        /// per-monitor DPI aware, so `at` is already in physical pixels.
        fn show(&self, at: &Rect, accent: [f64; 3]) {
            let width = at.width.round().max(1.0) as i32;
            let height = at.height.round().max(1.0) as i32;
            let channel = |value: f64| (value.clamp(0.0, 1.0) * 255.0).round() as u32;
            let pixel = (0xFF << 24)
                | (channel(accent[0]) << 16)
                | (channel(accent[1]) << 8)
                | channel(accent[2]);
            let pixels = vec![pixel; (width as usize) * (height as usize)];
            self.window.raise();
            let _ = self.window.present(
                at.x.round() as i32,
                at.y.round() as i32,
                width,
                height,
                &pixels,
            );
            self.window.pump();
            self.shown.set(true);
        }

        pub(crate) fn hide(&self) {
            let _ = self.window.present(0, 0, 0, 0, &[]);
            self.window.pump();
            self.shown.set(false);
        }

        /// Hides the caret when the cursor sets off from `from` for `to`
        /// somewhere else; a travel that stays put keeps it.
        pub(crate) fn hide_when_leaving(
            &self,
            from: &agent_desktop_core::Point,
            to: &agent_desktop_core::Point,
        ) {
            if super::leaves(from, to) {
                self.hide();
            }
        }
    }
}
