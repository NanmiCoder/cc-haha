use agent_desktop_core::{AdapterError, Deadline, NativeHandle, tree::state};
use zbus::Connection;

use crate::actions::write::mutation::Corroboration;
use crate::system::{ACCESSIBLE_INTERFACE, SharedBus, within};
use crate::tree::live_read::{read_live, with_reader};
use crate::tree::observe::node_evidence::NodeEvidence;
use crate::tree::observe::observation::Observation;
use crate::tree::properties::absence::failure;
use crate::tree::properties::failure::Failure;
use crate::tree::properties::node_read::call;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::vocabulary::role_numbers::PASSWORD_TEXT;
use crate::tree::vocabulary::state_bits::{CHECKED, EXPANDED, PRESSED, SELECTED, StateBits};
use crate::tree::{AtspiElement, Field};

/// One node read for an action, shared by a write and its read-back.
#[derive(Debug, Clone)]
pub(crate) struct NodeView {
    node: NodeEvidence,
}

fn confirmed(field: &Field<Vec<String>>) -> Option<&[String]> {
    match field {
        Field::Present(list) => Some(list),
        Field::Absent => Some(&[]),
        Field::Failed(_) => None,
    }
}

fn text_of(field: &Field<String>) -> Option<Option<String>> {
    match field {
        Field::Present(text) => Some(Some(text.clone())),
        Field::Absent => Some(None),
        Field::Failed(_) => None,
    }
}

impl NodeView {
    pub(crate) fn new(node: NodeEvidence) -> Self {
        Self { node }
    }

    pub(crate) fn role(&self) -> Option<u32> {
        self.node.read.node.traits.role.present().copied()
    }

    /// Whether a state bit is set, or `None` when the state read failed.
    pub(crate) fn state(&self, bit: u32) -> Option<bool> {
        self.node
            .read
            .node
            .traits
            .states
            .present()
            .map(|words| StateBits::new(words).has(bit))
    }

    pub(crate) fn tokens(&self) -> Option<&[String]> {
        self.node.evidence.states.known().map(Vec::as_slice)
    }

    pub(crate) fn interfaces(&self) -> Option<&[String]> {
        confirmed(&self.node.read.node.traits.interfaces)
    }

    pub(crate) fn action_names(&self) -> Option<&[String]> {
        confirmed(&self.node.read.node.actions)
    }

    pub(crate) fn name(&self) -> Option<&str> {
        self.node
            .read
            .node
            .properties
            .name
            .present()
            .map(String::as_str)
    }

    /// The node's value, withheld from a secure field whatever was read and
    /// from a read that stopped at the cap: a prefix is never the value, so
    /// no write is judged, verified or sized by it.
    pub(crate) fn value(&self) -> Option<&str> {
        if self.secure() || self.node.read.value.truncated {
            return None;
        }
        self.node.read.value.value.present().map(String::as_str)
    }

    pub(crate) fn child_count(&self) -> Option<usize> {
        let count = self.node.read.node.properties.child_count.present()?;
        usize::try_from(*count).ok()
    }

    /// Whether the node must be treated as a secure field. It fails closed:
    /// a password role is secure whatever the tokens say, and a node whose
    /// role or states could not be read is secure too, because the read that
    /// failed is the one that would have said so.
    pub(crate) fn secure(&self) -> bool {
        match (self.role(), self.tokens()) {
            (Some(PASSWORD_TEXT), _) | (None, _) | (_, None) => true,
            (Some(_), Some(tokens)) => tokens.iter().any(|token| token == state::SECURE),
        }
    }

    pub(crate) fn observation(&self) -> Observation {
        let value = if self.secure() || self.node.read.value.truncated {
            None
        } else {
            text_of(&self.node.read.value.value)
        };
        Observation {
            checked: self.state(CHECKED),
            expanded: self.state(EXPANDED),
            selected: self.state(SELECTED),
            pressed: self.state(PRESSED),
            value,
            name: text_of(&self.node.read.node.properties.name),
            child_count: self.child_count(),
        }
    }
}

/// Reads the node a handle names once, with the answers a failed read gets
/// everywhere else: a destroyed object or an application that left is a
/// settled stale ref, a node that did not answer is a timeout.
pub(crate) fn read_node_view(
    bus: &SharedBus,
    handle: &NativeHandle,
    deadline: Deadline,
) -> Result<NodeView, AdapterError> {
    with_reader(
        bus,
        handle,
        deadline,
        ReadPurpose::Element,
        |reader, handle| read_live(reader, handle).map(NodeView::new),
    )
}

/// What one `GetRole` outcome says about the node. Every live node of every
/// toolkit answers it, so an error naming a missing object or application is
/// the second witness a destroyed node needs, a timeout proves nothing, and
/// any other failure is not a reading.
pub(crate) fn corroboration_of(role_error: Option<&zbus::Error>) -> Corroboration {
    match role_error.map(failure) {
        None => Corroboration::Alive,
        Some(Failure::AppGone | Failure::Suspect) => Corroboration::Dead,
        Some(Failure::TimedOut) => Corroboration::TimedOut,
        Some(Failure::Other) => Corroboration::NotRead,
    }
}

async fn role_outcome(connection: &Connection, element: &AtspiElement) -> Corroboration {
    let reply = call(connection, element, ACCESSIBLE_INTERFACE, "GetRole", &()).await;
    corroboration_of(reply.as_ref().err())
}

/// Asks the node whether it still answers, once, inside the deadline.
pub(crate) fn corroborate(
    bus: &SharedBus,
    element: &AtspiElement,
    deadline: Deadline,
) -> Corroboration {
    let Ok(session) = bus.get(deadline) else {
        return Corroboration::NotRead;
    };
    let connection = session.inner().clone();
    within(deadline, async {
        Ok(role_outcome(&connection, element).await)
    })
    .unwrap_or(Corroboration::TimedOut)
}

#[cfg(test)]
#[path = "action_read_tests.rs"]
mod tests;
