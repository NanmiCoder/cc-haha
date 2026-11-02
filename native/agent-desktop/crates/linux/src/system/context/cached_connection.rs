use std::ffi::OsString;
use std::sync::{Mutex, PoisonError};

use agent_desktop_core::{AdapterError, Deadline};
use zbus::Connection;

pub(crate) struct CachedConnection {
    environment: Vec<Option<OsString>>,
    pub(crate) connection: Option<Connection>,
}

fn environment() -> Vec<Option<OsString>> {
    [
        "DBUS_SESSION_BUS_ADDRESS",
        "AT_SPI_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_SESSION_TYPE",
    ]
    .into_iter()
    .map(std::env::var_os)
    .collect()
}

pub(crate) fn get(
    slot: &Mutex<Option<CachedConnection>>,
    deadline: Deadline,
    open: impl FnOnce(bool) -> Result<Connection, AdapterError>,
) -> Result<Connection, AdapterError> {
    deadline.ensure_remaining()?;
    let scope = environment();
    let mut held = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if held
        .as_ref()
        .is_some_and(|cached| cached.environment != scope)
    {
        *held = None;
    }
    if let Some(connection) = held.as_ref().and_then(|cached| cached.connection.as_ref())
        && !connection.is_closed()
    {
        return Ok(connection.clone());
    }
    let reconnect = held.is_some();
    if let Some(cached) = held.as_mut() {
        cached.connection = None;
    }
    drop(held);
    let connection = open(reconnect)?;
    deadline.ensure_remaining()?;
    let mut held = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(cached) = held.as_ref()
        && cached.environment == scope
        && let Some(connection) = cached.connection.as_ref()
        && !connection.is_closed()
    {
        return Ok(connection.clone());
    }
    *held = Some(CachedConnection {
        environment: scope,
        connection: Some(connection.clone()),
    });
    Ok(connection)
}

pub(crate) fn forget(slot: &Mutex<Option<CachedConnection>>, connection: &Connection) {
    let mut held = slot.lock().unwrap_or_else(PoisonError::into_inner);
    if held
        .as_ref()
        .and_then(|cached| cached.connection.as_ref())
        .is_some_and(|cached| {
            cached.server_guid() == connection.server_guid()
                && cached.unique_name() == connection.unique_name()
        })
        && let Some(cached) = held.as_mut()
    {
        cached.connection = None;
    }
}

#[cfg(test)]
#[path = "cached_connection_tests.rs"]
mod tests;
