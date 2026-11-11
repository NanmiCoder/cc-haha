use agent_desktop_core::{AdapterError, Deadline};
use zbus::blocking::Connection;

use super::service_owner::ServiceOwner;
use crate::system::SharedBus;

pub(crate) struct ReadView {
    pub(crate) connection: Connection,
    owner: ServiceOwner,
}

impl ReadView {
    pub(crate) fn begin(bus: &SharedBus, deadline: Deadline) -> Result<Self, AdapterError> {
        let connection = bus.get(deadline)?;
        let owner = bus.registry_owner(&connection, deadline)?;
        bus.register_owner(&connection, &owner, deadline)?;
        Ok(Self { connection, owner })
    }

    pub(crate) fn finish(&self, deadline: Deadline) -> Result<(), AdapterError> {
        if ServiceOwner::read(self.connection.inner(), Some(&self.owner), deadline)? != self.owner {
            return Err(AdapterError::internal(
                "The registry service changed during the inventory read",
            )
            .with_suggestion("Retry with a fresh inventory before acting"));
        }
        deadline.ensure_remaining()
    }
}
