//! Polls queued placement with the 80 ms reread delay retained from A21-5.

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics};
use std::time::Duration;

pub(crate) fn wait_for_placement(
    deadline: Deadline,
    mut read: impl FnMut() -> Result<bool, AdapterError>,
) -> Result<(), AdapterError> {
    let after_write =
        |error: AdapterError| error.with_disposition(DeliverySemantics::delivered_unverified());
    loop {
        let pause = deadline
            .remaining_slice(Duration::from_millis(80))
            .map_err(after_write)?;
        std::thread::sleep(pause);
        deadline.ensure_remaining().map_err(after_write)?;
        if read().map_err(after_write)? {
            return Ok(());
        }
    }
}

#[cfg(test)]
#[path = "window_op_wait_tests.rs"]
mod tests;
