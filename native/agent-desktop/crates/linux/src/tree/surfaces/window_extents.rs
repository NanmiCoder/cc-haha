use agent_desktop_core::{AdapterError, Deadline};
use zbus::Connection;

use crate::system::{SharedBus, within};
use crate::tree::properties::node_read::call;
use crate::tree::{AtspiElement, COMPONENT_INTERFACE, Extents};

pub(crate) const WINDOW_COORDINATES: u32 = 1;

/// One `GetExtents` in window coordinates. Unavailable or malformed geometry
/// is unknown; a lost connection ends the read.
pub(crate) async fn read_window_extents_async(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<Option<Extents>, AdapterError> {
    read_extents_async(connection, element, WINDOW_COORDINATES).await
}

pub(crate) async fn read_extents_async(
    connection: &Connection,
    element: &AtspiElement,
    coordinates: u32,
) -> Result<Option<Extents>, AdapterError> {
    match crate::tree::properties::interface_support::supports(
        connection,
        element,
        COMPONENT_INTERFACE,
    )
    .await
    {
        Ok(true) => {}
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        _ => return Ok(None),
    }
    let reply = match call(
        connection,
        element,
        COMPONENT_INTERFACE,
        "GetExtents",
        &(coordinates,),
    )
    .await
    {
        Ok(reply) => reply,
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        Err(_) => return Ok(None),
    };
    let Ok((x, y, width, height)) = reply.body().deserialize::<(i32, i32, i32, i32)>() else {
        return Ok(None);
    };
    Ok(Some(Extents {
        x,
        y,
        width,
        height,
    }))
}

/// An element's rectangle in window coordinates, or `None` when it cannot be
/// read inside the deadline.
pub(crate) fn read_window_extents(
    bus: &SharedBus,
    element: &AtspiElement,
    deadline: Deadline,
) -> Option<Extents> {
    let connection = bus.get(deadline).ok()?;
    within(
        deadline,
        read_window_extents_async(connection.inner(), element),
    )
    .ok()
    .flatten()
}
