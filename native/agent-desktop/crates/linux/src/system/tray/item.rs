use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use zbus::Connection;
use zbus::zvariant::{OwnedValue, Value};

use super::{TrayTarget, call, introspect};

const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";
const NO_MENU: &str = "/NO_DBUSMENU";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ItemEvidence {
    pub(super) title: String,
    pub(super) passive: bool,
    pub(super) menu: Option<String>,
    pub(super) methods: Vec<String>,
}

fn text(value: &OwnedValue) -> Option<String> {
    match &**value {
        Value::Str(text) => Some(text.as_str().to_owned()),
        Value::ObjectPath(path) => Some(path.as_str().to_owned()),
        _ => None,
    }
}

fn from_map(map: &HashMap<String, OwnedValue>, methods: Vec<String>) -> ItemEvidence {
    let read = |key: &str| map.get(key).and_then(text);
    ItemEvidence {
        title: read("Title").unwrap_or_default(),
        passive: read("Status").as_deref() == Some("Passive"),
        menu: read("Menu").filter(|path| path.starts_with('/') && path != NO_MENU),
        methods,
    }
}

pub(super) fn read(
    connection: &Connection,
    target: &TrayTarget,
    deadline: Deadline,
) -> Result<ItemEvidence, AdapterError> {
    let props = call::all_properties(
        connection,
        &target.owner,
        &target.object_path,
        ITEM_INTERFACE,
        deadline,
    )
    .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?;
    if !matches!(
        props.get("Status").and_then(text).as_deref(),
        Some("Active" | "Passive" | "NeedsAttention")
    ) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Tray item Status is unavailable or invalid",
        )
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    let methods = introspect::item_methods(
        &call::introspect(connection, &target.owner, &target.object_path, deadline)
            .map_err(|error| error.with_disposition(DeliverySemantics::not_delivered()))?,
    );
    Ok(from_map(&props, methods))
}

#[cfg(test)]
#[path = "item_tests.rs"]
mod tests;
