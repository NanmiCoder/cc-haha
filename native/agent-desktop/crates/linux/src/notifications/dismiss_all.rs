use agent_desktop_core::{
    AdapterError, DismissAllNotificationsRequest, InteractionLease, NotificationInfo,
};

use super::close::close_entry;
use super::extract::Entry;
use super::list::{matches_app, read_listing};
use super::session::{Session, require_headed};
use super::verify::{holds, unconfirmed_read};
use super::world::{LiveWorld, ShellWorld};
use crate::system::SharedBus;
use crate::system::shell::light::same_object;

type Outcome = (Vec<NotificationInfo>, Vec<String>);

pub(crate) fn dismiss_all(
    bus: &SharedBus,
    request: DismissAllNotificationsRequest<'_>,
    lease: &InteractionLease,
) -> Result<Outcome, AdapterError> {
    dismiss_all_in(&LiveWorld::new(bus), request, lease)
}

/// Clears the list, or only the entries of one app, one entry at a time: each
/// entry is closed through its own header control and only counts as
/// dismissed when its own object has left the list. No button that acts on
/// the whole list is pressed, because none can be told apart by anything but
/// its place. The closed list is read first: an empty list, or an app filter
/// that matches nothing, needs no press and no open.
pub(crate) fn dismiss_all_in(
    world: &dyn ShellWorld,
    request: DismissAllNotificationsRequest<'_>,
    lease: &InteractionLease,
) -> Result<Outcome, AdapterError> {
    require_headed(request.policy)?;
    let captured: Vec<Entry> = read_listing(world, lease.deadline())?
        .into_iter()
        .filter(|entry| {
            request
                .app_filter
                .is_none_or(|app| matches_app(&entry.info, app))
        })
        .collect();
    if captured.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let session = Session::open(world, request.policy, lease)?;
    let result = close_each(world, &captured, request, lease);
    session.finish(result)
}

fn close_each(
    world: &dyn ShellWorld,
    captured: &[Entry],
    request: DismissAllNotificationsRequest<'_>,
    lease: &InteractionLease,
) -> Result<Outcome, AdapterError> {
    let mut failures: Vec<(usize, String)> = Vec::new();
    for target in captured {
        let before = read_listing(world, lease.deadline())?;
        let Some(entry) = before
            .iter()
            .find(|entry| same_object(&entry.node, &target.node))
        else {
            continue;
        };
        match close_entry(world, entry, &before, request.policy, lease) {
            Ok(_) => {}
            Err(unclosed) if unclosed.unread => return Err(unclosed.error),
            Err(unclosed) => failures.push((target.info.index, unclosed.error.message)),
        }
    }
    let after = read_listing(world, lease.deadline()).map_err(unconfirmed_read)?;
    let (gone, left): (Vec<&Entry>, Vec<&Entry>) = captured
        .iter()
        .partition(|entry| !holds(&after, &entry.node));
    for entry in left {
        let recorded = failures.iter().any(|(index, _)| *index == entry.info.index);
        if !recorded {
            let message = "notification from the captured set is still present".to_owned();
            failures.push((entry.info.index, message));
        }
    }
    Ok((
        gone.into_iter().map(|entry| entry.info.clone()).collect(),
        failures
            .into_iter()
            .map(|(index, message)| format!("#{index}: {message}"))
            .collect(),
    ))
}

#[cfg(test)]
#[path = "dismiss_all_tests.rs"]
mod tests;
