use agent_desktop_core::AdapterError;
use zbus::Connection;

use super::liveness::Liveness;
use super::node_read::{COMPONENT_INTERFACE, call, deserialize, field};
use crate::tree::element::bounded::collect_bounded;
use crate::tree::{AtspiElement, Extents, Field};

const ACTION_INTERFACE: &str = "org.a11y.atspi.Action";
const ACTION_NAMES_IN_FLIGHT: usize = 4;
const SCREEN_COORDINATES: u32 = 0;

/// `None` when the interface is advertised and its reads should go ahead.
/// When the interface list itself could not be read, nothing is known about
/// the interface, so the dependent field is a failure and not an absence.
pub(in crate::tree) fn skipped_without<T>(
    interfaces: &Field<Vec<String>>,
    name: &str,
) -> Option<Field<T>> {
    match interfaces {
        Field::Present(list) if list.iter().any(|entry| entry == name) => None,
        Field::Present(_) | Field::Absent => Some(Field::Absent),
        Field::Failed(detail) => Some(Field::Failed(format!(
            "interface list unavailable, {name} not checked: {detail}"
        ))),
    }
}

pub(in crate::tree) async fn read_extents(
    connection: &Connection,
    element: &AtspiElement,
    interfaces: &Field<Vec<String>>,
    liveness: Liveness,
) -> Result<Field<Extents>, AdapterError> {
    if let Some(skipped) = skipped_without(interfaces, COMPONENT_INTERFACE) {
        return Ok(skipped);
    }
    let reply = call(
        connection,
        element,
        COMPONENT_INTERFACE,
        "GetExtents",
        &(SCREEN_COORDINATES,),
    )
    .await;
    field(deserialize::<(i32, i32, i32, i32)>(reply), liveness).map(|read| {
        read.map(|(x, y, width, height)| Extents {
            x,
            y,
            width,
            height,
        })
    })
}

async fn action_name(
    connection: &Connection,
    element: &AtspiElement,
    index: i32,
    listed: String,
) -> Result<String, AdapterError> {
    let reply = call(connection, element, ACTION_INTERFACE, "GetName", &(index,)).await;
    match deserialize::<String>(reply) {
        Ok(name) if !name.is_empty() => Ok(name),
        Err(error) if crate::system::is_connection_failure(&error) => {
            Err(crate::system::classify(&error))
        }
        _ => Ok(listed),
    }
}

/// `GetName(i)` is the only call that returns the machine name on every
/// toolkit: `GetActions` returns empty names on Chromium and junk on Gecko.
/// `GetActions` supplies the count and the fallback for an index whose
/// `GetName` method is refused. Connection loss ends the read.
pub(in crate::tree) async fn read_actions(
    connection: &Connection,
    element: &AtspiElement,
    interfaces: &Field<Vec<String>>,
    liveness: Liveness,
) -> Result<Field<Vec<String>>, AdapterError> {
    if let Some(skipped) = skipped_without(interfaces, ACTION_INTERFACE) {
        return Ok(skipped);
    }
    let reply = call(connection, element, ACTION_INTERFACE, "GetActions", &()).await;
    let listed = field(
        deserialize::<Vec<(String, String, String)>>(reply),
        liveness,
    )?;
    Ok(match listed {
        Field::Present(entries) => Field::Present(
            collect_bounded(
                ACTION_NAMES_IN_FLIGHT,
                entries
                    .into_iter()
                    .enumerate()
                    .map(|(index, (name, _, _))| {
                        action_name(connection, element, index as i32, name)
                    }),
            )
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?,
        ),
        Field::Absent => Field::Absent,
        Field::Failed(detail) => Field::Failed(detail),
    })
}

#[cfg(test)]
#[path = "interface_reads_tests.rs"]
mod tests;
