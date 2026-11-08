use std::time::Duration;

use agent_desktop_core::{AdapterError, InteractionLease, InteractionPolicy, MouseButton};

use super::extract::Entry;
use super::target::missing_control;
use super::verify::{REMOVAL_SETTLE, bystanders, holds, pressed_without_effect, settle_read};
use super::world::ShellWorld;

const PRESS_SETTLE: Duration = Duration::from_millis(2_500);
const MAX_PRESSES: usize = 2;

/// Why an entry was not closed. `unread` marks a list that could not be read
/// after a press, which leaves the delivery in doubt for everything else.
pub(crate) struct Unclosed {
    pub(crate) error: AdapterError,
    pub(crate) unread: bool,
}

fn failed(error: AdapterError) -> Unclosed {
    Unclosed {
        error,
        unread: false,
    }
}

/// Closes one entry and proves it by its effect: the entry's own object must
/// leave the list, and no other, and another entry leaving ends the attempt as
/// a failure. The header's buttons are pressed last one first; a button that
/// only expands the entry leaves its object standing, so the next one is
/// pressed. The entry still standing after every press is a failure, never a
/// success.
pub(crate) fn close_entry(
    world: &dyn ShellWorld,
    entry: &Entry,
    before: &[Entry],
    policy: InteractionPolicy,
    lease: &InteractionLease,
) -> Result<Vec<Entry>, Unclosed> {
    let candidates: Vec<_> = entry.close_candidates().take(MAX_PRESSES).collect();
    if candidates.is_empty() {
        return Err(failed(missing_control("close button", entry.info.index)));
    }
    for (position, control) in candidates.iter().enumerate() {
        world
            .click(&control.element, MouseButton::Left, policy, lease)
            .map_err(failed)?;
        let last = position + 1 == candidates.len();
        let window = if last { REMOVAL_SETTLE } else { PRESS_SETTLE };
        let after = settle_read(world, lease.deadline(), window, |now| {
            !holds(now, &entry.node)
        })
        .map_err(|error| Unclosed {
            error,
            unread: true,
        })?;
        if !bystanders(before, &after, entry).is_empty() {
            return Err(failed(pressed_without_effect(
                "A notification other than the target left the message list during the dismissal",
                "Run list-notifications to see what the message list holds now",
            )));
        }
        if !holds(&after, &entry.node) {
            return Ok(after);
        }
    }
    Err(failed(pressed_without_effect(
        "The close control of the notification was pressed but the notification is still in the message list",
        "Run list-notifications and retry if the entry is still there",
    )))
}

#[cfg(test)]
#[path = "close_tests.rs"]
mod tests;
