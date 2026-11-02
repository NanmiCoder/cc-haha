use zbus::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::roles::role_of;
use crate::system::ACCESSIBLE_INTERFACE;
use crate::tree::properties::liveness::Liveness;
use crate::tree::properties::node_read::{NAME, call, get_one, string_value};
use crate::tree::{AtspiElement, Field, LabelOutcome, RawNode};
use agent_desktop_core::tree::roles::is_interactive_role;
use agent_desktop_core::{AdapterError, ErrorCode};

const LABELLED_BY: u32 = 2;

type RelationSet = Vec<(u32, Vec<(String, OwnedObjectPath)>)>;

pub(in crate::tree) async fn first_label_target(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<Option<AtspiElement>, zbus::Error> {
    let relations = call(
        connection,
        element,
        ACCESSIBLE_INTERFACE,
        "GetRelationSet",
        &(),
    )
    .await?
    .body()
    .deserialize::<RelationSet>()?;
    Ok(relations
        .into_iter()
        .find(|(kind, _)| *kind == LABELLED_BY)
        .and_then(|(_, targets)| targets.into_iter().next())
        .map(|(bus, path)| AtspiElement::new(bus, path.to_string(), element.pid())))
}

async fn name_of(
    connection: &Connection,
    target: &AtspiElement,
) -> Result<Field<String>, AdapterError> {
    get_one(connection, target, NAME, string_value, Liveness::Alive).await
}

const TEXT_INTERFACE: &str = "org.a11y.atspi.Text";

/// The text a label node holds when its own `Name` is blank: GTK 4 puts the
/// visible label of a menu item in the `Text` of its label node and leaves
/// the `Name` empty.
async fn text_of(connection: &Connection, target: &AtspiElement) -> Result<String, zbus::Error> {
    if !crate::tree::properties::interface_support::supports(connection, target, TEXT_INTERFACE)
        .await?
    {
        return Ok(String::new());
    }
    let reply = call(
        connection,
        target,
        TEXT_INTERFACE,
        "GetText",
        &(0_i32, -1_i32),
    )
    .await?;
    reply.body().deserialize::<String>()
}

/// Whether the node's label is worth reading: its own `Name` is blank, and its
/// canonical role is one a ref can point at. A blank container is never read,
/// so a tree full of unnamed panels costs no relation reads.
pub(crate) fn needs_label(node: &RawNode) -> bool {
    let blank = node.properties.name.is_blank();
    let Some(number) = node.traits.role.present() else {
        return false;
    };
    let role = role_of(
        *number,
        &node.traits.states,
        &node.traits.interfaces,
        &node.attributes,
    );
    blank && is_interactive_role(role.as_str())
}

/// Reads the label when the node needs it; any other node is unlabelled.
pub(crate) async fn read_label_if_needed(
    connection: &Connection,
    node: &RawNode,
) -> Result<LabelOutcome, AdapterError> {
    if needs_label(node) {
        read_label(connection, &node.element).await
    } else {
        Ok(LabelOutcome::Unlabelled)
    }
}

/// Reads the text of the node's `LabelledBy` target. Meant for a node whose
/// own `Name` is blank: it costs one relation read and one name read.
pub(crate) async fn read_label(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<LabelOutcome, AdapterError> {
    let target = match first_label_target(connection, element).await {
        Ok(Some(target)) => target,
        Ok(None) => return Ok(LabelOutcome::Unlabelled),
        Err(error) if crate::system::is_connection_failure(&error) => {
            return Err(crate::system::classify(&error));
        }
        Err(_) => return Ok(LabelOutcome::Failed),
    };
    let name = match name_of(connection, &target).await {
        Ok(name) => Some(name),
        Err(error)
            if matches!(
                error.code,
                ErrorCode::AppNotFound | ErrorCode::ElementNotFound
            ) =>
        {
            None
        }
        Err(error) => return Err(error),
    };
    match from_name(name) {
        Some(outcome) => Ok(outcome),
        None => from_text(text_of(connection, &target).await),
    }
}

/// The outcome the label target's `Name` settles, or `None` when the name is
/// blank and the target's `Text` has to be read.
fn from_name(name: Option<Field<String>>) -> Option<LabelOutcome> {
    match name {
        None | Some(Field::Failed(_)) => Some(LabelOutcome::Failed),
        Some(field) => field.non_blank().cloned().map(LabelOutcome::Text),
    }
}

fn from_text(text: Result<String, zbus::Error>) -> Result<LabelOutcome, AdapterError> {
    match text {
        Ok(text) if text.trim().is_empty() => Ok(LabelOutcome::Unlabelled),
        Ok(text) => Ok(LabelOutcome::Text(text)),
        Err(error) if crate::system::is_connection_failure(&error) => {
            Err(crate::system::classify(&error))
        }
        Err(_) => Ok(LabelOutcome::Failed),
    }
}

#[cfg(test)]
#[path = "label_read_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "label_transport_tests.rs"]
mod transport_tests;
