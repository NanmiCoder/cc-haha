use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode, InteractionLease, InteractionPolicy};
use serde_json::{Value, json};

use super::world::ShellWorld;
use crate::system::shell::open::Opened;

const CLEANUP_MS: u64 = 2_000;
const CLOSED_POLL: Duration = Duration::from_millis(50);
const OPEN_BY_HAND: &str = "Open the message list by hand, with the clock in the top bar, and retry: a list that is already showing is used as it is. Shell pointer input needs an X11 session";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Restore {
    Adopted,
    Closed,
    Unverified,
}

pub(crate) fn require_headed(policy: InteractionPolicy) -> Result<(), AdapterError> {
    if policy.is_headed() {
        return Ok(());
    }
    Err(AdapterError::policy_denied_for_policy(
        "Changing notifications moves the pointer on the shell and needs headed mode",
        policy,
    )
    .with_suggestion("Pass --headed to let the command click in the message list"))
}

/// The message list for one mutation. A list that was showing on entry is
/// adopted and left showing; a list this session opened is closed on the way
/// out, and the close is checked by reading `SHOWING` back.
pub(crate) struct Session<'a> {
    world: &'a dyn ShellWorld,
    lease: &'a InteractionLease,
    opened: bool,
}

impl<'a> Session<'a> {
    pub(crate) fn open(
        world: &'a dyn ShellWorld,
        policy: InteractionPolicy,
        lease: &'a InteractionLease,
    ) -> Result<Self, AdapterError> {
        world.require_daemon(lease.deadline())?;
        match world.open(policy, lease) {
            Ok((_, opened)) => Ok(Self {
                world,
                lease,
                opened: opened == Opened::Opened,
            }),
            Err(error) => {
                let by_call = error
                    .details
                    .as_ref()
                    .and_then(|details| details.get("surface_opened_by_call"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let restore = restore(world, lease, by_call);
                Err(with_restore(error.with_suggestion(OPEN_BY_HAND), restore))
            }
        }
    }

    pub(crate) fn finish<T>(self, result: Result<T, AdapterError>) -> Result<T, AdapterError> {
        let restore = restore(self.world, self.lease, self.opened);
        match (result, restore) {
            (Ok(value), Restore::Adopted | Restore::Closed) => Ok(value),
            (Ok(_), Restore::Unverified) => Err(with_restore(
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    "The call finished but the message list it opened could not be closed",
                )
                .with_suggestion(
                    "Close the message list by hand with Escape or a click on the date menu",
                ),
                restore,
            )),
            (Err(error), restore) => Err(with_restore(error, restore)),
        }
    }
}

/// Closes a list this session opened. The close runs on a deadline of its
/// own: the lease deadline is spent when the command waited out its whole
/// budget, and a close that shared it would leave the list open. The shell's
/// showing state can lag the click, so it is read until it reads closed.
fn restore(world: &dyn ShellWorld, lease: &InteractionLease, opened: bool) -> Restore {
    if !opened {
        return Restore::Adopted;
    }
    let closed = Deadline::detached_after(CLEANUP_MS)
        .and_then(|deadline| world.close(&lease.with_deadline(deadline)))
        .is_ok();
    let Ok(deadline) = Deadline::detached_after(CLEANUP_MS) else {
        return Restore::Unverified;
    };
    if !closed {
        return Restore::Unverified;
    }
    loop {
        match world.is_showing(deadline) {
            Ok(false) => return Restore::Closed,
            Ok(true) if !deadline.is_expired() => std::thread::sleep(CLOSED_POLL),
            _ => return Restore::Unverified,
        }
    }
}

fn with_restore(mut error: AdapterError, restore: Restore) -> AdapterError {
    let mut details = match error.details.take() {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    let name = match restore {
        Restore::Adopted => "adopted",
        Restore::Closed => "closed",
        Restore::Unverified => "unverified",
    };
    details.insert("list_restore".to_owned(), json!(name));
    error.with_details(Value::Object(details))
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_lease_tests.rs"]
mod lease_tests;
