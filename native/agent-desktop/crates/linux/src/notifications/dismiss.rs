use agent_desktop_core::{
    AdapterError, DismissNotificationRequest, InteractionLease, NotificationInfo,
};

use super::close::close_entry;
use super::session::{Session, require_headed};
use super::target::{Wanted, locate, reconfirm};
use super::world::{LiveWorld, ShellWorld};
use crate::system::SharedBus;

pub(crate) fn dismiss(
    bus: &SharedBus,
    request: DismissNotificationRequest<'_>,
    lease: &InteractionLease,
) -> Result<NotificationInfo, AdapterError> {
    dismiss_in(&LiveWorld::new(bus), request, lease)
}

/// Removes exactly the entry at the index through its own header control and
/// proves it by re-reading the list: the entry's object left, and no other
/// entry's did. The closed list is read first, so a missing or changed entry
/// is refused without opening anything.
pub(crate) fn dismiss_in(
    world: &dyn ShellWorld,
    request: DismissNotificationRequest<'_>,
    lease: &InteractionLease,
) -> Result<NotificationInfo, AdapterError> {
    require_headed(request.policy)?;
    let wanted = Wanted {
        index: request.index,
        app_filter: request.app_filter,
        identity: request.identity,
    };
    let first = locate(world, wanted, lease.deadline())?;
    let session = Session::open(world, request.policy, lease)?;
    let result = reconfirm(world, wanted, first.entry(), lease.deadline()).and_then(|ready| {
        close_entry(world, ready.entry(), &ready.all, request.policy, lease)
            .map(|_| ready.entry().info.clone())
            .map_err(|unclosed| unclosed.error)
    });
    session.finish(result)
}

#[cfg(test)]
#[path = "dismiss_tests.rs"]
mod tests;
