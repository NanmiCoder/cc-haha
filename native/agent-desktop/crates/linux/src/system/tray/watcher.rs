use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use zbus::zvariant::OwnedValue;

use super::call;

const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const REGISTERED: &str = "RegisteredStatusNotifierItems";

/// The registration strings the watcher lists, as it lists them.
pub(crate) fn registered_items(deadline: Deadline) -> Result<Vec<String>, AdapterError> {
    let connection = call::session(deadline)?;
    require_owner(call::unique_owner(&connection, WATCHER, deadline)?)?;
    let reply = call::call(
        &connection,
        call::Endpoint {
            destination: WATCHER,
            path: WATCHER_PATH,
            interface: "org.freedesktop.DBus.Properties",
        },
        "Get",
        &(WATCHER, REGISTERED),
        deadline,
    )?;
    let value: OwnedValue = reply
        .body()
        .deserialize()
        .map_err(|error| call::fault(&error))?;
    Vec::<String>::try_from(value).map_err(|error| {
        AdapterError::internal("The tray watcher's item list could not be read")
            .with_platform_detail(error.to_string())
    })
}

pub(crate) fn require(deadline: Deadline) -> Result<(), AdapterError> {
    let connection = call::session(deadline)?;
    require_owner(call::unique_owner(&connection, WATCHER, deadline)?)
}

fn require_owner(owner: Option<String>) -> Result<(), AdapterError> {
    owner.map(|_| ()).ok_or_else(watcher_absent)
}

fn watcher_absent() -> AdapterError {
    AdapterError::new(
        ErrorCode::PlatformNotSupported,
        "No system tray watcher is running in this session",
    )
    .with_suggestion("Start a tray backend providing org.kde.StatusNotifierWatcher in this session")
    .with_details(serde_json::json!({ "watcher": "absent" }))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "watcher_tests.rs"]
mod tests;
