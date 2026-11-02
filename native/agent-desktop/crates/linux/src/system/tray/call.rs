use std::collections::HashMap;
use std::io::ErrorKind;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use zbus::export::serde::Serialize;
use zbus::zvariant::{DynamicType, OwnedValue};
use zbus::{Connection, Message};

use crate::system::bus::session_bus::SessionBus;
use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN, within};

const BUS_DAEMON: &str = "org.freedesktop.DBus";
const BUS_DAEMON_PATH: &str = "/org/freedesktop/DBus";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const INTROSPECTABLE: &str = "org.freedesktop.DBus.Introspectable";
const UNKNOWN_METHOD: &str = "org.freedesktop.DBus.Error.UnknownMethod";
const UNKNOWN_OBJECT: &str = "org.freedesktop.DBus.Error.UnknownObject";
const UNKNOWN_INTERFACE: &str = "org.freedesktop.DBus.Error.UnknownInterface";

pub(super) fn session(deadline: Deadline) -> Result<Connection, AdapterError> {
    SessionBus::get(deadline)
}

pub(super) fn owner_gone() -> AdapterError {
    AdapterError::stale_ref_because(
        "The tray item's owner is no longer on the bus, so the ref names a process that left",
    )
}

pub(super) fn fault(error: &zbus::Error) -> AdapterError {
    if let zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _) = error
        && io.kind() == ErrorKind::TimedOut
    {
        return AdapterError::timeout("The tray item did not answer in time")
            .with_platform_detail(error.to_string())
            .with_disposition(DeliverySemantics::uncertain());
    }
    if let zbus::Error::MethodError(name, _, _) = error {
        return match name.as_str() {
            SERVICE_UNKNOWN | NAME_HAS_NO_OWNER => owner_gone(),
            UNKNOWN_METHOD | UNKNOWN_OBJECT | UNKNOWN_INTERFACE => AdapterError::new(
                ErrorCode::ActionNotSupported,
                "The tray item does not implement the method that was called",
            )
            .with_platform_detail(error.to_string())
            .with_disposition(DeliverySemantics::not_delivered()),
            _ => AdapterError::new(ErrorCode::ActionFailed, "The tray item refused the call")
                .with_platform_detail(error.to_string()),
        };
    }
    AdapterError::new(ErrorCode::Internal, "The session bus call failed")
        .with_platform_detail(error.to_string())
}

/// Where a bus call goes: the owner, the object and the interface.
#[derive(Clone, Copy)]
pub(super) struct Endpoint<'a> {
    pub(super) destination: &'a str,
    pub(super) path: &'a str,
    pub(super) interface: &'a str,
}

pub(super) fn call<B>(
    connection: &Connection,
    endpoint: Endpoint<'_>,
    method: &str,
    body: &B,
    deadline: Deadline,
) -> Result<Message, AdapterError>
where
    B: Serialize + DynamicType,
{
    within(deadline, async {
        connection
            .call_method(
                Some(endpoint.destination),
                endpoint.path,
                Some(endpoint.interface),
                method,
                body,
            )
            .await
            .map_err(|error| fault(&error))
    })
}

pub(super) fn owner_alive(
    connection: &Connection,
    unique_name: &str,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    call(
        connection,
        Endpoint {
            destination: BUS_DAEMON,
            path: BUS_DAEMON_PATH,
            interface: BUS_DAEMON,
        },
        "NameHasOwner",
        &(unique_name,),
        deadline,
    )?
    .body()
    .deserialize::<bool>()
    .map_err(|error| fault(&error))
}

pub(super) fn require_owner(
    connection: &Connection,
    unique_name: &str,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if owner_alive(connection, unique_name, deadline)? {
        Ok(())
    } else {
        Err(owner_gone())
    }
}

pub(super) fn unique_owner(
    connection: &Connection,
    name: &str,
    deadline: Deadline,
) -> Result<Option<String>, AdapterError> {
    if name.starts_with(':') {
        return Ok(owner_alive(connection, name, deadline)?.then(|| name.to_owned()));
    }
    let reply = call(
        connection,
        Endpoint {
            destination: BUS_DAEMON,
            path: BUS_DAEMON_PATH,
            interface: BUS_DAEMON,
        },
        "GetNameOwner",
        &(name,),
        deadline,
    );
    match reply {
        Ok(message) => message
            .body()
            .deserialize::<String>()
            .map(Some)
            .map_err(|error| fault(&error)),
        Err(error) if error.code == ErrorCode::StaleRef => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn all_properties(
    connection: &Connection,
    destination: &str,
    path: &str,
    interface: &str,
    deadline: Deadline,
) -> Result<HashMap<String, OwnedValue>, AdapterError> {
    call(
        connection,
        Endpoint {
            destination,
            path,
            interface: PROPERTIES,
        },
        "GetAll",
        &(interface,),
        deadline,
    )?
    .body()
    .deserialize::<HashMap<String, OwnedValue>>()
    .map_err(|error| fault(&error))
}

pub(super) fn introspect(
    connection: &Connection,
    destination: &str,
    path: &str,
    deadline: Deadline,
) -> Result<String, AdapterError> {
    call(
        connection,
        Endpoint {
            destination,
            path,
            interface: INTROSPECTABLE,
        },
        "Introspect",
        &(),
        deadline,
    )?
    .body()
    .deserialize::<String>()
    .map_err(|error| fault(&error))
}

#[cfg(test)]
#[path = "call_tests.rs"]
mod tests;
