use std::collections::BTreeMap;

use agent_desktop_core::AdapterError;
use futures_util::future::{join, join3, join4};
use zbus::export::serde::Serialize;
use zbus::zvariant::{DynamicDeserialize, DynamicType, OwnedValue};
use zbus::{Connection, Message};

use super::absence::gone_error;
use super::interface_reads::{read_actions, read_extents};
use super::liveness::Liveness;
use super::read_purpose::ReadPurpose;
use crate::system::{ACCESSIBLE_INTERFACE, PROPERTIES_INTERFACE};
use crate::tree::{AtspiElement, ChildAddress, Field, NodeProperties, NodeTraits, RawNode};

pub(crate) const COMPONENT_INTERFACE: &str = "org.a11y.atspi.Component";
pub(in crate::tree) const NAME: &str = "Name";
const DESCRIPTION: &str = "Description";
const CHILD_COUNT: &str = "ChildCount";
const ACCESSIBLE_ID: &str = "AccessibleId";
const NULL_PATH: &str = "/org/a11y/atspi/null";

pub(in crate::tree) type Reply = Result<Message, zbus::Error>;

pub(in crate::tree) fn deserialize<T>(reply: Reply) -> Result<T, zbus::Error>
where
    T: for<'de> DynamicDeserialize<'de>,
{
    reply?.body().deserialize()
}

pub(crate) async fn call<B>(
    connection: &Connection,
    element: &AtspiElement,
    interface: &str,
    method: &str,
    body: &B,
) -> Reply
where
    B: Serialize + DynamicType,
{
    connection
        .call_method(
            Some(element.bus_name()),
            element.path(),
            Some(interface),
            method,
            body,
        )
        .await
}

/// A read's outcome as a field. An error that shows the application or the
/// object gone fails the node read; any other failure, including a name from
/// the suspect family on a node that still answers, stays on its field.
pub(in crate::tree) fn field<T>(
    result: Result<T, zbus::Error>,
    liveness: Liveness,
) -> Result<Field<T>, AdapterError> {
    match result {
        Ok(value) => Ok(Field::Present(value)),
        Err(error) if crate::system::is_connection_failure(&error) => {
            Err(crate::system::classify(&error))
        }
        Err(error) => match gone_error(&error, liveness) {
            Some(gone) => Err(gone),
            None => Ok(Field::Failed(error.to_string())),
        },
    }
}

pub(in crate::tree) fn string_value(value: &OwnedValue) -> Field<String> {
    match value.downcast_ref::<&str>() {
        Ok(text) => Field::Present(text.to_owned()),
        Err(error) => Field::Failed(error.to_string()),
    }
}

fn count_value(value: &OwnedValue) -> Field<i32> {
    match value.downcast_ref::<i32>() {
        Ok(count) => Field::Present(count),
        Err(error) => Field::Failed(error.to_string()),
    }
}

fn read_property<T>(
    reply: Reply,
    convert: fn(&OwnedValue) -> Field<T>,
    liveness: Liveness,
) -> Result<Field<T>, AdapterError> {
    Ok(match field(deserialize::<OwnedValue>(reply), liveness)? {
        Field::Present(value) => convert(&value),
        Field::Absent => Field::Absent,
        Field::Failed(detail) => Field::Failed(detail),
    })
}

pub(in crate::tree) async fn get_one<T>(
    connection: &Connection,
    element: &AtspiElement,
    key: &'static str,
    convert: fn(&OwnedValue) -> Field<T>,
    liveness: Liveness,
) -> Result<Field<T>, AdapterError> {
    let reply = call(
        connection,
        element,
        PROPERTIES_INTERFACE,
        "Get",
        &(ACCESSIBLE_INTERFACE, key),
    )
    .await;
    let read = field(deserialize::<OwnedValue>(reply), liveness)?;
    Ok(match read {
        Field::Present(value) => convert(&value),
        Field::Absent => Field::Failed(format!("Properties.Get({key}) failed")),
        Field::Failed(detail) => Field::Failed(format!("Properties.Get({key}) failed: {detail}")),
    })
}

pub(in crate::tree) fn read_children(
    reply: Reply,
    liveness: Liveness,
) -> Result<Field<Vec<ChildAddress>>, AdapterError> {
    let raw = field(
        deserialize::<Vec<(String, zbus::zvariant::OwnedObjectPath)>>(reply),
        liveness,
    )?;
    Ok(raw.map(|entries| {
        entries
            .into_iter()
            .filter(|(bus, path)| !bus.is_empty() && path.as_str() != NULL_PATH)
            .map(|(bus, path)| (bus, path.to_string()))
            .collect()
    }))
}

fn selected<T>(reply: Option<Reply>, liveness: Liveness) -> Result<Field<T>, AdapterError>
where
    T: for<'de> DynamicDeserialize<'de>,
{
    match reply {
        Some(reply) => field(deserialize(reply), liveness),
        None => Ok(Field::Failed("field not requested".to_owned())),
    }
}

/// L41-7: individual property reads avoid toolkit crashes in bulk reads.
/// Reads one node. All fixed calls are in flight together; extents and
/// actions follow only when the interface list names them. The node's own
/// `GetRole` outcome, which every live node answers, decides what a failure
/// of any other call means: an error that shows the application or the object
/// gone fails the read; any other failure stays on the field it hit. The
/// second value is `Alive`, or `TimedOut` when the role call did not answer
/// in time, which says nothing about the object.
pub(crate) async fn read_node_for(
    connection: &Connection,
    element: &AtspiElement,
    purpose: ReadPurpose,
) -> Result<(RawNode, Liveness), AdapterError> {
    let accessible = |method: &'static str, needed| async move {
        if needed {
            Some(call(connection, element, ACCESSIBLE_INTERFACE, method, &()).await)
        } else {
            None
        }
    };
    let (first, second) = join(
        join4(
            async {
                if purpose.identity() || purpose == ReadPurpose::Actions {
                    Some(
                        join4(
                            call(
                                connection,
                                element,
                                PROPERTIES_INTERFACE,
                                "Get",
                                &(ACCESSIBLE_INTERFACE, NAME),
                            ),
                            call(
                                connection,
                                element,
                                PROPERTIES_INTERFACE,
                                "Get",
                                &(ACCESSIBLE_INTERFACE, DESCRIPTION),
                            ),
                            call(
                                connection,
                                element,
                                PROPERTIES_INTERFACE,
                                "Get",
                                &(ACCESSIBLE_INTERFACE, CHILD_COUNT),
                            ),
                            call(
                                connection,
                                element,
                                PROPERTIES_INTERFACE,
                                "Get",
                                &(ACCESSIBLE_INTERFACE, ACCESSIBLE_ID),
                            ),
                        )
                        .await,
                    )
                } else {
                    None
                }
            },
            accessible("GetRole", true),
            accessible("GetRoleName", purpose.vocabulary()),
            accessible("GetState", purpose != ReadPurpose::Shape),
        ),
        join3(
            accessible(
                "GetInterfaces",
                !matches!(
                    purpose,
                    ReadPurpose::Structure | ReadPurpose::Shape | ReadPurpose::Gate
                ),
            ),
            accessible("GetAttributes", purpose.vocabulary()),
            accessible("GetChildren", purpose.children()),
        ),
    )
    .await;
    let (properties, role, role_name, state) = first;
    let (interfaces, attributes, child_reply) = second;
    let role = role.map(deserialize::<u32>);
    let liveness = Liveness::of(role.as_ref().and_then(|read| read.as_ref().err()));
    let properties = match properties {
        Some((name, description, child_count, accessible_id)) => NodeProperties {
            name: read_property(name, string_value, liveness)?,
            description: read_property(description, string_value, liveness)?,
            child_count: read_property(child_count, count_value, liveness)?,
            accessible_id: read_property(accessible_id, string_value, liveness)?,
        },
        None => {
            let mut properties = NodeProperties::failed("field not requested");
            if matches!(purpose, ReadPurpose::Frame | ReadPurpose::Structure) {
                properties.name =
                    get_one(connection, element, NAME, string_value, liveness).await?;
            }
            properties
        }
    };
    let interfaces = selected(interfaces, liveness)?;
    let (extents, actions) = join(
        async {
            if purpose.bounds() {
                read_extents(connection, element, &interfaces, liveness).await
            } else {
                Ok(Field::Failed("field not requested".to_owned()))
            }
        },
        async {
            if purpose.actions() {
                read_actions(connection, element, &interfaces, liveness).await
            } else {
                Ok(Field::Failed("field not requested".to_owned()))
            }
        },
    )
    .await;
    let node = RawNode {
        element: element.clone(),
        properties,
        traits: NodeTraits {
            role: role.map_or_else(
                || Ok(Field::Failed("role not read".to_owned())),
                |read| field(read, liveness),
            )?,
            role_name: selected(role_name, liveness)?,
            states: selected(state, liveness)?,
            interfaces,
        },
        attributes: selected::<BTreeMap<String, String>>(attributes, liveness)?,
        extents: extents?,
        actions: actions?,
        children: match child_reply {
            Some(reply) => read_children(reply, liveness)?,
            None => Field::Failed("field not requested".to_owned()),
        },
    };
    Ok((node, liveness))
}

pub(crate) async fn read_node(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<RawNode, AdapterError> {
    read_node_for(connection, element, ReadPurpose::Snapshot)
        .await
        .map(|(node, _)| node)
}

#[cfg(test)]
#[path = "node_read_tests.rs"]
mod tests;
