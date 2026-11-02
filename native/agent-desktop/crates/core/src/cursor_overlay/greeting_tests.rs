//! The greeting an overlay announces itself with.
//!
//! Split from `tests.rs` so that file stays inside the size cap.

use super::*;

/// The greeting is what an overlay with nothing to say announces itself with,
/// so it stays the fallback rather than being deleted along with the defect.
#[test]
fn an_enable_with_no_label_still_greets() {
    let enable = CursorOverlayControl::enable("run-1".into(), CursorOverlayStyle::default());

    assert_eq!(enable.label(), Some(CURSOR_OVERLAY_GREETING));
}
