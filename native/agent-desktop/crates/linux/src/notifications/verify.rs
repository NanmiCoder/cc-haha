use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, NotificationInfo};

use super::extract::Entry;
use super::list::read_listing;
use super::signal::Signal;
use super::world::ShellWorld;
use crate::system::shell::light::same_object;
use crate::tree::AtspiElement;

const POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const REMOVAL_SETTLE: Duration = Duration::from_millis(6_000);

/// Whether the object still stands in a reading of the list.
pub(crate) fn holds(list: &[Entry], node: &AtspiElement) -> bool {
    list.iter().any(|entry| same_object(&entry.node, node))
}

/// The words a mutation verifies against: source application, title and body.
pub(crate) fn same_identity(left: &NotificationInfo, right: &NotificationInfo) -> bool {
    left.app_name == right.app_name && left.title == right.title && left.body == right.body
}

/// The entries of `before`, other than the target, that `after` no longer
/// holds: notifications that left while only the target should have.
pub(crate) fn bystanders<'a>(
    before: &'a [Entry],
    after: &[Entry],
    target: &Entry,
) -> Vec<&'a Entry> {
    before
        .iter()
        .filter(|entry| !same_object(&entry.node, &target.node) && !holds(after, &entry.node))
        .collect()
}

/// What proves an action took effect. The entry leaving the list is the
/// proof; an action signal only sharpens it, and only when it is the single
/// one seen in the window, because no id is held to tie a signal to the press.
pub(crate) fn evidence(signals: &[Signal], target_gone: bool) -> Option<&'static str> {
    let invoked = signals
        .iter()
        .filter(|signal| matches!(signal, Signal::ActionInvoked(_)))
        .count();
    match (target_gone, invoked) {
        (false, _) => None,
        (true, 1) => Some("action_invoked"),
        (true, _) => Some("entry_removed"),
    }
}

/// Re-reads the list until `done` holds or the settle window closes, and
/// returns the last listing either way. An expired window is an answer, not
/// an error: the caller decides what survival means.
pub(crate) fn settle_read(
    world: &dyn ShellWorld,
    deadline: Deadline,
    window: Duration,
    done: impl Fn(&[Entry]) -> bool,
) -> Result<Vec<Entry>, AdapterError> {
    let settle = deadline.capped(window);
    let mut current = read_listing(world, settle).map_err(unconfirmed_read)?;
    loop {
        if done(&current) || settle.is_expired() {
            return Ok(current);
        }
        std::thread::sleep(settle.remaining_slice(POLL_INTERVAL)?);
        current = match read_listing(world, settle) {
            Ok(listing) => listing,
            Err(error) if error.code == ErrorCode::Timeout => return Ok(current),
            Err(error) => return Err(unconfirmed_read(error)),
        };
    }
}

/// A press went out and its effect did not show as required.
pub(crate) fn pressed_without_effect(message: impl Into<String>, suggestion: &str) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
        .with_suggestion(suggestion)
        .with_disposition(DeliverySemantics::delivered_unverified())
}

/// The press went out, so a list that cannot be read afterwards leaves the
/// delivery in doubt and never turns it into a bare failure of the read.
pub(crate) fn unconfirmed_read(error: AdapterError) -> AdapterError {
    pressed_without_effect(
        "The click was delivered but the message list could not be read afterwards",
        "Run list-notifications to see what the message list holds now",
    )
    .with_platform_detail(error.message)
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;
