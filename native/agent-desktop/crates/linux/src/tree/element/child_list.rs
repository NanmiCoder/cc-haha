use agent_desktop_core::{AdapterError, ErrorCode};
use zbus::Connection;

use crate::system::ACCESSIBLE_INTERFACE;
use crate::tree::properties::liveness::Liveness;
use crate::tree::properties::node_read::{call, read_children};
use crate::tree::{AtspiElement, ChildAddress, Field};

/// The children of an object as `GetChildren` lists them, with the null
/// placeholder entries removed.
pub(crate) async fn list_children(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<Vec<ChildAddress>, AdapterError> {
    let reply = call(
        connection,
        element,
        ACCESSIBLE_INTERFACE,
        "GetChildren",
        &(),
    )
    .await;
    match read_children(reply, Liveness::Alive)? {
        Field::Present(children) => Ok(children),
        Field::Absent => Ok(Vec::new()),
        Field::Failed(detail) => Err(AdapterError::new(
            ErrorCode::Internal,
            "The children of the accessible object could not be listed",
        )
        .with_platform_detail(detail)),
    }
}
