use std::io::ErrorKind;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use agent_desktop_core::{AdapterError, DEFAULT_OPERATION_TIMEOUT_MS, Deadline, ErrorCode};
use zbus::Connection as AsyncConnection;
use zbus::blocking::Connection;
use zbus::connection::Builder;

use crate::system::bus::bus_deadline::within;
use crate::system::bus::bus_fault::BusFault;
use crate::system::bus::bus_stage::Stage;
use crate::system::context::cached_connection::{self, CachedConnection};
use crate::system::context::service_owner::ServiceOwner;

const BUS_SERVICE: &str = "org.a11y.Bus";
const BUS_PATH: &str = "/org/a11y/bus";
pub(crate) const REGISTRY_SERVICE: &str = "org.a11y.atspi.Registry";
pub(crate) const REGISTRY_ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const REGISTRY_PATH: &str = "/org/a11y/atspi/registry";
const REGISTRY_INTERFACE: &str = "org.a11y.atspi.Registry";
const LISTENED_EVENT: &str = "window:activate";
pub(crate) const PROPERTIES_INTERFACE: &str = "org.freedesktop.DBus.Properties";
pub(crate) const ACCESSIBLE_INTERFACE: &str = "org.a11y.atspi.Accessible";

pub(crate) fn classify(error: &zbus::Error) -> AdapterError {
    classify_at(Stage::AccessibilityBus, error)
}

pub(crate) fn classify_at(stage: Stage, error: &zbus::Error) -> AdapterError {
    if let zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) = error
        && io.kind() == ErrorKind::TimedOut
    {
        return AdapterError::timeout("The accessibility bus did not answer in time")
            .with_platform_detail(error.to_string());
    }
    match BusFault::of(stage, error) {
        Some(fault) => fault.into_error(error),
        None => AdapterError::new(
            ErrorCode::Internal,
            "The accessibility bus returned an unexpected error",
        )
        .with_suggestion("Retry the command; report the platform detail if it persists")
        .with_platform_detail(error.to_string()),
    }
}

fn discover_address(deadline: Deadline, reconnect: bool) -> Result<String, AdapterError> {
    within(deadline, async {
        let session = Builder::session()
            .map_err(|error| classify_at(Stage::SessionBus, &error))?
            .build()
            .await
            .map_err(|error| classify_at(Stage::SessionBus, &error))?;
        let proxy = zbus::Proxy::new(&session, BUS_SERVICE, BUS_PATH, BUS_SERVICE)
            .await
            .map_err(|error| classify_at(Stage::SessionBus, &error))?;
        let flags = if reconnect {
            zbus::proxy::MethodFlags::NoAutoStart.into()
        } else {
            Default::default()
        };
        proxy
            .call_with_flags("GetAddress", flags, &())
            .await
            .map_err(|error| classify_at(Stage::SessionBus, &error))?
            .ok_or_else(|| AdapterError::internal("The accessibility bus returned no address"))
    })
}

fn connect(deadline: Deadline, reconnect: bool) -> Result<Connection, AdapterError> {
    deadline.ensure_remaining()?;
    let address = discover_address(deadline, reconnect)?;
    deadline.ensure_remaining()?;
    let connection: AsyncConnection = within(deadline, async {
        Builder::address(address.as_str())
            .map_err(|error| classify(&error))?
            .method_timeout(Duration::from_millis(DEFAULT_OPERATION_TIMEOUT_MS))
            .build()
            .await
            .map_err(|error| classify(&error))
    })?;
    register_connection(connection, deadline)
}

fn register_connection(
    connection: AsyncConnection,
    deadline: Deadline,
) -> Result<Connection, AdapterError> {
    within(deadline, announce_listener(&connection))?;
    Ok(connection.into())
}

/// Chromium and Electron track which window is active only once an assistive
/// client has told the registry it listens for events, and until then a
/// window the window manager has made active still reads as not active. A
/// client that never reads the tree through libatspi has to say so itself.
async fn announce_listener(connection: &AsyncConnection) -> Result<(), AdapterError> {
    connection
        .call_method(
            Some(REGISTRY_SERVICE),
            REGISTRY_PATH,
            Some(REGISTRY_INTERFACE),
            "RegisterEvent",
            &(LISTENED_EVENT, Vec::<String>::new(), ""),
        )
        .await
        .map(|_| ())
        .map_err(|error| classify(&error))
}

/// Reads `ChildCount` from the AT-SPI registry root, which answers even when
/// no application is registered. A connection-level failure drops `connection`
/// from `bus` so the next call reconnects.
pub(crate) fn probe_registry(
    bus: &SharedBus,
    connection: &Connection,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining()?;
    within(deadline, async {
        connection
            .inner()
            .call_method(
                Some(REGISTRY_SERVICE),
                REGISTRY_ROOT_PATH,
                Some(PROPERTIES_INTERFACE),
                "Get",
                &(ACCESSIBLE_INTERFACE, "ChildCount"),
            )
            .await
            .map(|_| ())
            .map_err(|error| {
                if is_connection_failure(&error) {
                    bus.forget(connection);
                }
                classify(&error)
            })
    })?;
    deadline.ensure_remaining()
}

pub(crate) fn is_connection_failure(error: &zbus::Error) -> bool {
    match error {
        zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) => {
            io.kind() != ErrorKind::TimedOut
        }
        zbus::Error::MethodError(..) => false,
        _ => false,
    }
}

/// The process-wide accessibility connection, opened on first use. A success
/// is kept; a failure is returned and the next call tries again.
#[derive(Default)]
pub(crate) struct SharedBus {
    slot: Mutex<Option<CachedConnection>>,
    owner: Mutex<Option<ServiceOwner>>,
}

impl SharedBus {
    #[cfg(test)]
    fn cached(&self) -> Option<Connection> {
        self.slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(|cached| cached.connection.clone().map(Into::into))
    }

    pub(crate) fn get(&self, deadline: Deadline) -> Result<Connection, AdapterError> {
        cached_connection::get(&self.slot, deadline, |reconnect| {
            connect(deadline, reconnect)
                .map(|connection| connection.inner().clone())
                .map_err(|error| {
                    if reconnect && error.code == ErrorCode::PlatformNotSupported {
                        AdapterError::internal("The established accessibility bus was lost")
                            .with_suggestion(
                                "Retry after the application's accessibility connection recovers",
                            )
                            .with_platform_detail(error.platform_detail.unwrap_or(error.message))
                    } else {
                        error
                    }
                })
        })
        .map(Into::into)
    }

    pub(crate) fn forget_cached(&self) {
        if let Some(cached) = self
            .slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            cached.connection = None;
        }
    }

    pub(crate) fn registry_owner(
        &self,
        connection: &Connection,
        deadline: Deadline,
    ) -> Result<ServiceOwner, AdapterError> {
        let known = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        ServiceOwner::read(connection.inner(), known.as_ref(), deadline)
    }

    pub(crate) fn register_owner(
        &self,
        connection: &Connection,
        owner: &ServiceOwner,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let registered = self
            .owner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if registered.as_ref() != Some(owner) {
            let _registered = register_connection(connection.inner().clone(), deadline)?;
            *self.owner.lock().unwrap_or_else(PoisonError::into_inner) = Some(owner.clone());
        }
        Ok(())
    }

    pub(crate) fn forget(&self, connection: &Connection) {
        cached_connection::forget(&self.slot, connection.inner());
    }
}

#[cfg(test)]
#[path = "bus_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "bus_live_tests.rs"]
mod live_tests;

#[cfg(test)]
mod recovery_tests;

#[cfg(test)]
#[path = "registry_pid_tests.rs"]
mod registry_pid_tests;

pub(super) mod bus_deadline {
    use std::future::Future;
    use std::time::Duration;

    use agent_desktop_core::{AdapterError, Deadline};
    use async_io::Timer;
    use futures_lite::future::or;

    /// Drives `future` to completion, giving up with the deadline's timeout error
    /// once the caller's remaining budget is spent.
    pub(crate) fn within<T>(
        deadline: Deadline,
        future: impl Future<Output = Result<T, AdapterError>>,
    ) -> Result<T, AdapterError> {
        let slice = deadline.remaining_slice(Duration::MAX)?;
        zbus::block_on(or(future, async move {
            Timer::after(slice).await;
            Err(deadline.timeout_error())
        }))
    }
}
pub(super) mod bus_fault;
pub(super) mod bus_process {
    use agent_desktop_core::AdapterError;
    use zbus::Connection;

    use crate::system::classify;

    const BUS_DAEMON: &str = "org.freedesktop.DBus";
    const BUS_DAEMON_PATH: &str = "/org/freedesktop/DBus";

    /// The process id behind a unique bus name as the bus daemon reports it, with
    /// the daemon's own error. A name nobody owns is `NameHasNoOwner`, which means
    /// the application left, so a caller that must tell that from an unreachable
    /// bus reads the error itself.
    pub(crate) async fn owner_process_id(
        connection: &Connection,
        bus_name: &str,
    ) -> Result<u32, zbus::Error> {
        connection
            .call_method(
                Some(BUS_DAEMON),
                BUS_DAEMON_PATH,
                Some(BUS_DAEMON),
                "GetConnectionUnixProcessID",
                &(bus_name,),
            )
            .await
            .and_then(|reply| reply.body().deserialize::<u32>())
    }

    /// The process id behind a unique bus name, asked of the bus daemon, which
    /// answers even for a process that has stopped answering its own calls.
    pub(crate) async fn process_id(
        connection: &Connection,
        bus_name: String,
    ) -> (String, Result<u32, AdapterError>) {
        let pid = owner_process_id(connection, &bus_name)
            .await
            .map_err(|error| classify(&error));
        (bus_name, pid)
    }
}
pub(super) mod bus_slice {
    use std::future::Future;
    use std::time::Duration;

    use async_io::Timer;
    use futures_lite::future::or;

    /// Awaits `future` for at most `slice`; `None` means it did not answer in
    /// time, which is how a stopped application looks from the bus.
    pub(crate) async fn within_slice<T>(
        slice: Duration,
        future: impl Future<Output = T>,
    ) -> Option<T> {
        or(async { Some(future.await) }, async {
            Timer::after(slice).await;
            None
        })
        .await
    }
}
pub(super) mod bus_stage;
pub(crate) mod session_bus;
