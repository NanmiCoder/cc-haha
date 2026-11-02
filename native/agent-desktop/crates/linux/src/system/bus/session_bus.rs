use std::io::ErrorKind;
use std::sync::Mutex;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use serde_json::json;
use zbus::Connection;
use zbus::connection::Builder;

use super::bus_deadline::within;
use super::bus_fault::BusFault;

use crate::system::context::cached_connection::{self, CachedConnection};

static SLOT: Mutex<Option<CachedConnection>> = Mutex::new(None);

/// The process-wide connection to the desktop session bus, opened on first
/// use. It is a separate slot from the accessibility connection: services such
/// as Mutter's RemoteDesktop answer here and never on the accessibility bus.
pub(crate) struct SessionBus;

pub(crate) fn is_transport_failure(error: &zbus::Error) -> bool {
    matches!(
        error,
        zbus::Error::InputOutput(_) | zbus::Error::Connection(..)
    )
}

fn unreachable(source: &zbus::Error) -> AdapterError {
    if let zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) = source
        && io.kind() == ErrorKind::TimedOut
    {
        return AdapterError::timeout("The session bus did not answer in time")
            .with_platform_detail(source.to_string());
    }
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "The D-Bus session bus is not available in this session",
    )
    .with_suggestion(BusFault::NoSessionBus.suggestion())
    .with_details(json!({ "retryable": false }))
    .with_platform_detail(source.to_string())
}

fn open(deadline: Deadline) -> Result<Connection, AdapterError> {
    within(deadline, async {
        Builder::session()
            .map_err(|error| unreachable(&error))?
            .build()
            .await
            .map_err(|error| unreachable(&error))
    })
}

impl SessionBus {
    pub(crate) fn get(deadline: Deadline) -> Result<Connection, AdapterError> {
        cached_connection::get(&SLOT, deadline, |_| open(deadline))
    }

    pub(crate) fn forget(connection: &Connection) {
        cached_connection::forget(&SLOT, connection);
    }
}

#[cfg(test)]
#[path = "session_bus_tests.rs"]
mod tests;
