use crate::tree::placement::visibility::is_placed;
use agent_desktop_core::{AdapterError, Deadline, ErrorCode};
use futures_util::future::{join_all, join5};
use zbus::Connection;
use zbus::zvariant::OwnedValue;

use crate::system::{ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, SharedBus, within};
use crate::tree::properties::absence::UNKNOWN_OBJECT;
use crate::tree::vocabulary::state_bits::{SHOWING, StateBits, VISIBLE};
use crate::tree::{AtspiElement, COMPONENT_INTERFACE, Extents, list_children};

const SCREEN_COORDINATES: u32 = 0;
const LEVEL_IN_FLIGHT: usize = 48;

/// The five things a landmark rule reads about one shell node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Light {
    pub(crate) element: AtspiElement,
    pub(crate) role: u32,
    pub(crate) name: String,
    pub(crate) extents: Option<Extents>,
    pub(crate) showing: bool,
    pub(crate) visible: bool,
    pub(crate) children: Vec<AtspiElement>,
}

impl Light {
    pub(crate) fn placed(&self) -> Option<Extents> {
        self.extents.filter(|extents| is_placed(*extents))
    }
}

/// Whether two addresses name the same accessibility object, whatever else
/// each was built with.
pub(crate) fn same_object(left: &AtspiElement, right: &AtspiElement) -> bool {
    left.bus_name() == right.bus_name() && left.path() == right.path()
}

/// Reads shell nodes. The bus implements it; a test substitutes a tree.
pub(crate) trait Nodes {
    fn read(&self, element: &AtspiElement) -> Result<Light, AdapterError>;

    fn read_level(&self, elements: &[AtspiElement]) -> Vec<Result<Light, AdapterError>> {
        elements.iter().map(|element| self.read(element)).collect()
    }
}

async fn name_of(connection: &Connection, element: &AtspiElement) -> String {
    let reply = connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(PROPERTIES_INTERFACE),
            "Get",
            &(ACCESSIBLE_INTERFACE, "Name"),
        )
        .await;
    reply
        .ok()
        .and_then(|reply| reply.body().deserialize::<OwnedValue>().ok())
        .and_then(|value| value.downcast_ref::<&str>().ok().map(str::to_owned))
        .unwrap_or_default()
}

async fn role_of(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<Option<u32>, AdapterError> {
    let reply = match connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(ACCESSIBLE_INTERFACE),
            "GetRole",
            &(),
        )
        .await
    {
        Ok(reply) => reply,
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        Err(_) => return Ok(None),
    };
    Ok(reply.body().deserialize::<u32>().ok())
}

async fn states_of(connection: &Connection, element: &AtspiElement) -> Option<Vec<u32>> {
    let reply = connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(ACCESSIBLE_INTERFACE),
            "GetState",
            &(),
        )
        .await
        .ok()?;
    reply.body().deserialize::<Vec<u32>>().ok()
}

pub(crate) async fn extents_of(connection: &Connection, element: &AtspiElement) -> Option<Extents> {
    if !crate::tree::properties::interface_support::supports(
        connection,
        element,
        COMPONENT_INTERFACE,
    )
    .await
    .ok()?
    {
        return None;
    }
    let reply = connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(COMPONENT_INTERFACE),
            "GetExtents",
            &(SCREEN_COORDINATES,),
        )
        .await
        .ok()?;
    let (x, y, width, height) = reply.body().deserialize::<(i32, i32, i32, i32)>().ok()?;
    Some(Extents {
        x,
        y,
        width,
        height,
    })
}

pub(crate) fn live_extents(
    bus: &SharedBus,
    element: &AtspiElement,
    deadline: Deadline,
) -> Result<Option<Extents>, AdapterError> {
    let connection = bus.get(deadline)?.inner().clone();
    within(deadline, async {
        Ok(extents_of(&connection, element).await)
    })
}

/// A node that dies between its parent's listing and its own read answers
/// `UnknownObject`: it has left the tree and is not broken.
fn missing_when_dead(error: AdapterError) -> AdapterError {
    let dead = error.code == ErrorCode::Internal
        && error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains(UNKNOWN_OBJECT));
    if dead {
        return AdapterError::new(
            ErrorCode::ElementNotFound,
            "The shell node left the tree before it was read",
        );
    }
    error
}

async fn read_one(connection: &Connection, element: &AtspiElement) -> Result<Light, AdapterError> {
    let (children, name, role, states, extents) = join5(
        list_children(connection, element),
        name_of(connection, element),
        role_of(connection, element),
        states_of(connection, element),
        extents_of(connection, element),
    )
    .await;
    let children = children.map_err(missing_when_dead)?;
    let role = role?.ok_or_else(|| {
        AdapterError::new(ErrorCode::ElementNotFound, "The shell node did not answer")
    })?;
    let bits = states.as_deref().map(StateBits::new);
    Ok(Light {
        element: element.address(),
        role,
        name,
        extents,
        showing: bits.is_some_and(|bits| bits.has(SHOWING)),
        visible: bits.is_some_and(|bits| bits.has(VISIBLE)),
        children: children
            .into_iter()
            .map(|(bus, path)| AtspiElement::new(bus, path, element.pid()))
            .collect(),
    })
}

pub(crate) struct LiveNodes {
    connection: Connection,
    deadline: Deadline,
}

impl LiveNodes {
    pub(crate) fn new(connection: Connection, deadline: Deadline) -> Self {
        Self {
            connection,
            deadline,
        }
    }
}

impl Nodes for LiveNodes {
    fn read(&self, element: &AtspiElement) -> Result<Light, AdapterError> {
        within(self.deadline, read_one(&self.connection, element))
    }

    fn read_level(&self, elements: &[AtspiElement]) -> Vec<Result<Light, AdapterError>> {
        let mut reads = Vec::with_capacity(elements.len());
        for chunk in elements.chunks(LEVEL_IN_FLIGHT) {
            let chunk_reads = within(self.deadline, async {
                Ok(join_all(
                    chunk
                        .iter()
                        .map(|element| read_one(&self.connection, element)),
                )
                .await)
            });
            match chunk_reads {
                Ok(done) => reads.extend(done),
                Err(error) => {
                    reads.extend(chunk.iter().map(|_| Err(error.clone())));
                }
            }
        }
        reads
    }
}

#[cfg(test)]
#[path = "light_tests.rs"]
mod tests;
