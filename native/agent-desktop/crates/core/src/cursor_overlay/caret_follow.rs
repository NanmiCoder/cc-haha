//! Keeps the agent's caret on the insertion point after a key press.
//!
//! A key such as an arrow or a formatting shortcut can move the insertion
//! point without any text being typed, which would leave a caret drawn by an
//! earlier `type` behind. The app handles the key after it is posted, so the
//! insertion point is read until two reads agree after a short settle, inside
//! a small budget.

use std::time::{Duration, Instant};

use crate::{AdapterError, CommandContext, Deadline, ErrorCode, PlatformAdapter, ProcessId, Rect};

const SETTLE: Duration = Duration::from_millis(60);
const SETTLE_LIMIT: Duration = Duration::from_millis(240);
const POLL: Duration = Duration::from_millis(20);
const READ_BUDGET_MS: u64 = 150;

/// After a key press reaches `process` (or the focused app, when `None`),
/// moves a caret the overlay is showing to the focused text element's
/// insertion point, or hides it when there is none. Nothing is sent when the
/// overlay is off or the adapter cannot read the focused insertion point.
pub(crate) fn follow_caret_after_key(
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
    process: Option<ProcessId>,
) {
    if !context.cursor_overlay().is_enabled() {
        return;
    }
    let read = |deadline| adapter.get_focused_insertion_caret(process, deadline);
    if let Some(caret) = settled_caret(read, POLL) {
        super::submit_caret_follow(adapter, context, caret);
    }
}

/// The insertion point once it has settled: the first read that matches the
/// one before it after [`SETTLE`], or the last read at [`SETTLE_LIMIT`].
/// `None` when the adapter does not support the read or the first read fails.
fn settled_caret(
    read: impl Fn(Deadline) -> Result<Option<Rect>, AdapterError>,
    poll: Duration,
) -> Option<Option<Rect>> {
    let started = Instant::now();
    let mut previous: Option<Option<Rect>> = None;
    loop {
        let current = match Deadline::after(READ_BUDGET_MS).map(&read) {
            Ok(Ok(current)) => current,
            Ok(Err(error))
                if matches!(
                    error.code,
                    ErrorCode::PlatformNotSupported | ErrorCode::ActionNotSupported
                ) =>
            {
                return None;
            }
            Ok(Err(_)) | Err(_) => return previous,
        };
        let elapsed = started.elapsed();
        if elapsed >= SETTLE_LIMIT || (elapsed >= SETTLE && previous == Some(current)) {
            return Some(current);
        }
        previous = Some(current);
        std::thread::sleep(poll);
    }
}

#[cfg(test)]
#[path = "caret_follow_tests.rs"]
mod tests;
