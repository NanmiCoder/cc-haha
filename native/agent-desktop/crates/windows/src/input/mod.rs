/// Defines a thread-local recording sink for a physical input event type —
/// `reset`/`recorded`/`record` over a `RefCell<Vec<$event>>` — so
/// `keyboard_send.rs` and `mouse_send.rs` do not each hand-write the same
/// 21-line module for their own event type.
macro_rules! define_input_fake_sink {
    ($name:ident, $event:ty) => {
        #[cfg(all(test, target_os = "windows"))]
        pub(crate) mod $name {
            use std::cell::RefCell;

            thread_local! {
                static RECORDED: RefCell<Vec<$event>> = const { RefCell::new(Vec::new()) };
            }

            pub(crate) fn reset() {
                RECORDED.with(|cell| cell.borrow_mut().clear());
            }

            pub(crate) fn recorded() -> Vec<$event> {
                RECORDED.with(|cell| cell.borrow().clone())
            }

            pub(super) fn record(events: &[$event]) {
                RECORDED.with(|cell| cell.borrow_mut().extend_from_slice(events));
            }
        }
    };
}
pub(crate) use define_input_fake_sink;

pub(crate) mod blocked_combo;
#[cfg(target_os = "windows")]
pub(crate) mod clipboard;
pub(crate) mod drag;
mod drag_state;
pub(crate) mod elevation;
pub(crate) mod keyboard;
pub(crate) mod mouse;
mod release_state;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use drag_state::DragReleaseGuard;
#[cfg(all(test, target_os = "windows"))]
pub(crate) use keyboard::keyboard_event::KeyReleaseGuard;
#[cfg(all(test, target_os = "windows"))]
pub(crate) use keyboard::keyboard_send::keyboard_send_fake_sink;
#[cfg(all(test, target_os = "windows"))]
pub(crate) use keyboard::keyboard_text::{ensure_chunk_budget, preflight_text};
#[cfg(all(test, target_os = "windows"))]
pub(crate) use mouse::mouse_coord::NormalizedPoint;
#[cfg(all(test, target_os = "windows"))]
pub(crate) use mouse::mouse_send::mouse_send_fake_sink;
