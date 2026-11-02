use std::io::ErrorKind;

use super::failure::Failure;
use super::liveness::Liveness;
use super::read_failure::ReadFailure;

use agent_desktop_core::{AdapterError, ErrorCode};

use crate::system::{NAME_HAS_NO_OWNER, SERVICE_UNKNOWN, within};

pub(crate) const UNKNOWN_OBJECT: &str = "org.freedesktop.DBus.Error.UnknownObject";
pub(crate) const UNKNOWN_METHOD: &str = "org.freedesktop.DBus.Error.UnknownMethod";
pub(crate) const UNKNOWN_INTERFACE: &str = "org.freedesktop.DBus.Error.UnknownInterface";

pub(crate) fn failure_of_name(name: &str) -> Failure {
    match name {
        SERVICE_UNKNOWN | NAME_HAS_NO_OWNER => Failure::AppGone,
        UNKNOWN_OBJECT | UNKNOWN_METHOD | UNKNOWN_INTERFACE => Failure::Suspect,
        _ => Failure::Other,
    }
}

pub(crate) fn failure(error: &zbus::Error) -> Failure {
    match error {
        zbus::Error::MethodError(name, _, _) => failure_of_name(name.as_str()),
        zbus::Error::InputOutput(io) | zbus::Error::Connection(io, _)
            if io.kind() == ErrorKind::TimedOut =>
        {
            Failure::TimedOut
        }
        _ => Failure::Other,
    }
}

pub(crate) fn read_failure(failure: Failure, liveness: Liveness) -> ReadFailure {
    match (failure, liveness) {
        (Failure::AppGone, _) | (_, Liveness::AppGone) => ReadFailure::AppGone,
        (_, Liveness::ObjectGone) => ReadFailure::ObjectGone,
        _ => ReadFailure::Failed,
    }
}

pub(crate) fn app_left(error: &zbus::Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppNotFound,
        "The application left the accessibility bus",
    )
    .with_platform_detail(error.to_string())
}

pub(crate) fn element_gone(error: &zbus::Error) -> AdapterError {
    AdapterError::new(
        ErrorCode::ElementNotFound,
        "The accessible object no longer exists",
    )
    .with_platform_detail(error.to_string())
}

/// The error that ends a node read when a call shows the object or its
/// application gone, or `None` when the failure stays on its field.
pub(crate) fn gone_error(error: &zbus::Error, liveness: Liveness) -> Option<AdapterError> {
    match read_failure(failure(error), liveness) {
        ReadFailure::AppGone => Some(app_left(error)),
        ReadFailure::ObjectGone => Some(element_gone(error)),
        ReadFailure::Failed => None,
    }
}

/// Whether the node's parent is absent or its readable child list no longer
/// names the node. A
/// parent or child list that cannot be read proves nothing.
pub(crate) fn listing_verdict(
    parent: Option<Option<Vec<(String, String)>>>,
    bus_name: &str,
    path: &str,
) -> bool {
    match parent {
        None | Some(None) => false,
        Some(Some(children)) => !children
            .iter()
            .any(|(name, child)| name == bus_name && child == path),
    }
}

pub(in crate::tree) fn parent_lacks(
    connection: &zbus::Connection,
    element: &crate::tree::AtspiElement,
    deadline: agent_desktop_core::Deadline,
) -> bool {
    let listing = within(deadline, async {
        Ok(parent_listing(connection, element).await)
    });
    listing.is_ok_and(|parent| listing_verdict(parent, element.bus_name(), element.path()))
}

async fn parent_listing(
    connection: &zbus::Connection,
    element: &crate::tree::AtspiElement,
) -> Option<Option<Vec<(String, String)>>> {
    use zbus::zvariant::{OwnedValue, Structure, Value};
    let reply = super::node_read::call(
        connection,
        element,
        crate::system::PROPERTIES_INTERFACE,
        "Get",
        &(crate::system::ACCESSIBLE_INTERFACE, "Parent"),
    )
    .await
    .ok()?;
    let value = reply.body().deserialize::<OwnedValue>().ok()?;
    let structure = Structure::try_from(value).ok()?;
    let [Value::Str(name), Value::ObjectPath(path)] = structure.fields() else {
        return None;
    };
    if path.as_str() == "/org/a11y/atspi/null" {
        return Some(Some(Vec::new()));
    }
    if name.is_empty() {
        return None;
    }
    let parent = crate::tree::AtspiElement::new(name.to_string(), path.to_string(), element.pid());
    Some(
        crate::tree::list_children(connection, &parent)
            .await
            .ok()
            .map(|children| children.into_iter().collect()),
    )
}

#[cfg(test)]
#[path = "absence_tests.rs"]
mod tests;
