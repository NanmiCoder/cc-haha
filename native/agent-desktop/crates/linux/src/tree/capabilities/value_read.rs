use agent_desktop_core::AdapterError;
use zbus::Connection;
use zbus::zvariant::OwnedValue;

use crate::system::PROPERTIES_INTERFACE;
use crate::tree::properties::node_read::call;
use crate::tree::vocabulary::role_numbers::{
    COMBO_BOX, DIAL, ENTRY, LEVEL_BAR, PROGRESS_BAR, SCROLL_BAR, SLIDER, SPIN_BUTTON, TERMINAL,
    TEXT,
};
use crate::tree::vocabulary::state_bits::{EDITABLE, StateBits};
use crate::tree::{AtspiElement, Field, RawNode};

const VALUE_INTERFACE: &str = "org.a11y.atspi.Value";
const TEXT_INTERFACE: &str = "org.a11y.atspi.Text";
const MAX_TEXT_CHARACTERS: i32 = 64 * 1024;

/// Where a node's value comes from, decided from what the node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueSource {
    None,
    Unknown,
    Numeric,
    Text,
}

/// The value of a node and whether it was cut to fit the field budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValueRead {
    pub(crate) value: Field<String>,
    pub(crate) truncated: bool,
}

impl ValueRead {
    pub(crate) fn absent() -> Self {
        Self {
            value: Field::Absent,
            truncated: false,
        }
    }

    fn failed(detail: String) -> Self {
        Self {
            value: Field::Failed(detail),
            truncated: false,
        }
    }
}

fn advertises(node: &RawNode, interface: &str) -> bool {
    node.traits
        .interfaces
        .present()
        .is_some_and(|names| names.iter().any(|name| name == interface))
}

fn editable(node: &RawNode) -> bool {
    node.traits
        .states
        .present()
        .is_some_and(|words| StateBits::new(words).has(EDITABLE))
}

/// Which read supplies this node's value. Only the roles that carry one are
/// read, and only through an interface the node names. A password field has
/// no value source. Free text counts only on an editable text node: a
/// read-only text node is content, not a control value.
pub(crate) fn value_source(node: &RawNode) -> ValueSource {
    let Some(role) = node.traits.role.present() else {
        return ValueSource::Unknown;
    };
    let (source, interface) = match *role {
        SLIDER | SPIN_BUTTON | PROGRESS_BAR | SCROLL_BAR | LEVEL_BAR | DIAL => {
            (ValueSource::Numeric, VALUE_INTERFACE)
        }
        ENTRY | COMBO_BOX => (ValueSource::Text, TEXT_INTERFACE),
        TEXT | TERMINAL if node.traits.states.is_failed() => return ValueSource::Unknown,
        TEXT | TERMINAL if editable(node) => (ValueSource::Text, TEXT_INTERFACE),
        _ => return ValueSource::None,
    };
    if node.traits.interfaces.is_failed() {
        ValueSource::Unknown
    } else if advertises(node, interface) {
        source
    } else {
        ValueSource::None
    }
}

/// Cuts `text` to at most `max_bytes`, never inside a character. The flag
/// says whether anything was removed.
pub(crate) fn truncate_to_boundary(text: String, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut kept = text;
    kept.truncate(end);
    (kept, true)
}

/// A number as text without a trailing `.0`, or `None` when it is not finite.
pub(crate) fn number_text(number: f64) -> Option<String> {
    number.is_finite().then(|| format!("{number}"))
}

async fn property(
    connection: &Connection,
    element: &AtspiElement,
    interface: &str,
    name: &str,
) -> Result<OwnedValue, zbus::Error> {
    call(
        connection,
        element,
        PROPERTIES_INTERFACE,
        "Get",
        &(interface, name),
    )
    .await?
    .body()
    .deserialize::<OwnedValue>()
}

async fn read_number(
    connection: &Connection,
    element: &AtspiElement,
) -> Result<ValueRead, zbus::Error> {
    let current = property(connection, element, VALUE_INTERFACE, "CurrentValue").await?;
    let number = current.downcast_ref::<f64>()?;
    Ok(match number_text(number) {
        Some(text) => ValueRead {
            value: Field::Present(text),
            truncated: false,
        },
        None => ValueRead::failed("CurrentValue is not a finite number".to_owned()),
    })
}

async fn read_text(
    connection: &Connection,
    element: &AtspiElement,
    max_bytes: usize,
) -> Result<ValueRead, zbus::Error> {
    let count = property(connection, element, TEXT_INTERFACE, "CharacterCount").await?;
    let count = count.downcast_ref::<i32>()?;
    let end = count.clamp(0, MAX_TEXT_CHARACTERS);
    let text = call(connection, element, TEXT_INTERFACE, "GetText", &(0i32, end))
        .await?
        .body()
        .deserialize::<String>()?;
    let (kept, cut) = truncate_to_boundary(text, max_bytes);
    Ok(ValueRead {
        value: Field::Present(kept),
        truncated: cut || count > end,
    })
}

/// Reads the value of a node that has a value source. A node with none is
/// answered-absent without a bus call; a read that fails is a failure, never
/// an empty value.
pub(crate) async fn read_value(
    connection: &Connection,
    node: &RawNode,
    max_bytes: usize,
) -> Result<ValueRead, AdapterError> {
    let outcome = match value_source(node) {
        ValueSource::None => return Ok(ValueRead::absent()),
        ValueSource::Unknown => {
            return Ok(ValueRead::failed(
                "Value prerequisites were unreadable".to_owned(),
            ));
        }
        ValueSource::Numeric => read_number(connection, &node.element).await,
        ValueSource::Text => read_text(connection, &node.element, max_bytes).await,
    };
    match outcome {
        Ok(value) => Ok(value),
        Err(error) if crate::system::is_connection_failure(&error) => {
            Err(crate::system::classify(&error))
        }
        Err(error) => Ok(ValueRead::failed(error.to_string())),
    }
}

#[cfg(test)]
#[path = "value_read_tests.rs"]
mod tests;
