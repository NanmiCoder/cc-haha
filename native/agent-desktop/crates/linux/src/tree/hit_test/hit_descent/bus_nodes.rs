use agent_desktop_core::{AdapterError, Deadline};
use zbus::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use super::{Described, Hit, NodeSource};
use crate::system::{ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE, within};
use crate::tree::properties::node_read::call;
use crate::tree::surfaces::window_extents::{WINDOW_COORDINATES, read_extents_async};
use crate::tree::{AtspiElement, COMPONENT_INTERFACE, Extents, list_children};

const NULL_PATH: &str = "/org/a11y/atspi/null";

/// The bus behind a descent. Every call races the deadline.
/// L41-25: Qt uses screen reads translated by the calibrated window origin.
pub(crate) struct BusNodes<'a> {
    pub(crate) connection: &'a Connection,
    pub(crate) deadline: Deadline,
    pub(crate) screen_origin: Option<(i32, i32)>,
}

fn named(bus: String, path: String, owner: &AtspiElement) -> Hit {
    if bus.is_empty() || path == NULL_PATH {
        Hit::Null
    } else {
        Hit::Object(AtspiElement::new(bus, path, owner.pid()))
    }
}

async fn string_property(
    connection: &Connection,
    node: &AtspiElement,
    name: &'static str,
) -> Option<String> {
    let reply = call(
        connection,
        node,
        PROPERTIES_INTERFACE,
        "Get",
        &(ACCESSIBLE_INTERFACE, name),
    )
    .await
    .ok()?;
    let value = reply.body().deserialize::<OwnedValue>().ok()?;
    value.downcast_ref::<&str>().ok().map(str::to_owned)
}

impl NodeSource for BusNodes<'_> {
    fn at_point(&mut self, from: &AtspiElement, point: (i32, i32)) -> Result<Hit, AdapterError> {
        let (point, coordinates) = if let Some(origin) = self.screen_origin {
            let Some(point) = point
                .0
                .checked_add(origin.0)
                .zip(point.1.checked_add(origin.1))
            else {
                return Ok(Hit::Failed);
            };
            (point, 0)
        } else {
            (point, WINDOW_COORDINATES)
        };
        within(self.deadline, async {
            if !crate::tree::properties::interface_support::supports(
                self.connection,
                from,
                COMPONENT_INTERFACE,
            )
            .await
            .unwrap_or(false)
            {
                return Ok(Hit::Failed);
            }
            let reply = call(
                self.connection,
                from,
                COMPONENT_INTERFACE,
                "GetAccessibleAtPoint",
                &(point.0, point.1, coordinates),
            )
            .await;
            let Ok(message) = reply else {
                return Ok(Hit::Failed);
            };
            Ok(
                match message.body().deserialize::<(String, OwnedObjectPath)>() {
                    Ok((bus, path)) => named(bus, path.to_string(), from),
                    Err(_) => Hit::Failed,
                },
            )
        })
    }

    fn verified_parent(
        &mut self,
        node: &AtspiElement,
    ) -> Result<Option<AtspiElement>, AdapterError> {
        within(self.deadline, async {
            let Ok(reply) = call(
                self.connection,
                node,
                PROPERTIES_INTERFACE,
                "Get",
                &(ACCESSIBLE_INTERFACE, "Parent"),
            )
            .await
            else {
                return Ok(None);
            };
            let Ok(value) = reply.body().deserialize::<OwnedValue>() else {
                return Ok(None);
            };
            let Ok((bus, path)) = <(String, OwnedObjectPath)>::try_from(value) else {
                return Ok(None);
            };
            let Hit::Object(parent) = named(bus, path.to_string(), node) else {
                return Ok(None);
            };
            let listed = list_children(self.connection, &parent).await;
            Ok(listed.ok().and_then(|children| {
                children
                    .iter()
                    .any(|(bus, path)| bus == node.bus_name() && path == node.path())
                    .then_some(parent)
            }))
        })
    }

    fn children(&mut self, node: &AtspiElement) -> Result<Option<Vec<AtspiElement>>, AdapterError> {
        within(self.deadline, async {
            Ok(list_children(self.connection, node)
                .await
                .ok()
                .map(|children| {
                    children
                        .into_iter()
                        .map(|(bus, path)| AtspiElement::new(bus, path, node.pid()))
                        .collect()
                }))
        })
    }

    fn describe(&mut self, node: &AtspiElement) -> Result<Described, AdapterError> {
        within(self.deadline, async {
            let role = call(
                self.connection,
                node,
                ACCESSIBLE_INTERFACE,
                "GetRoleName",
                &(),
            )
            .await
            .ok()
            .and_then(|message| message.body().deserialize::<String>().ok())
            .filter(|role| !role.is_empty());
            let name = string_property(self.connection, node, "Name")
                .await
                .filter(|name| !name.is_empty());
            let coordinates = if self.screen_origin.is_some() {
                0
            } else {
                WINDOW_COORDINATES
            };
            let window_extents = read_extents_async(self.connection, node, coordinates)
                .await?
                .and_then(|rect| match self.screen_origin {
                    Some(origin) => crate::tree::placement::frame_geometry::window_point(
                        origin,
                        (rect.x, rect.y),
                    )
                    .map(|(x, y)| Extents { x, y, ..rect }),
                    None => Some(rect),
                });
            Ok(Described {
                role,
                name,
                window_extents,
            })
        })
    }
}
