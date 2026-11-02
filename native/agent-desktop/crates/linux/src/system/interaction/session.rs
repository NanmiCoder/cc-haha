use agent_desktop_core::{AdapterError, AdapterSession, Deadline};
use zbus::blocking::Connection;

use crate::system::SharedBus;

/// Holds a clone of the shared accessibility connection and no element handles.
pub(crate) struct LinuxAdapterSession {
    connection: Connection,
}

pub(crate) fn open(
    bus: &SharedBus,
    deadline: Deadline,
) -> Result<LinuxAdapterSession, AdapterError> {
    Ok(LinuxAdapterSession {
        connection: bus.get(deadline)?,
    })
}

impl AdapterSession for LinuxAdapterSession {
    fn close(self: Box<Self>) -> Result<(), AdapterError> {
        drop(self.connection);
        Ok(())
    }
}
