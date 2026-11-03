use zbus::Connection;

use crate::system::REGISTRY_ROOT_PATH;
use crate::system::window::window_filter::frame_state;
use crate::system::x11::twin_tie::Twins;
use crate::tree::{AtspiElement, ReadPurpose, list_children, read_node_for};

/// One top-level frame of an application, as far as its reads answered.
pub(crate) struct Sibling {
    pub(crate) bus_name: String,
    pub(crate) path: String,
    pub(crate) title: Option<String>,
    pub(crate) active: Option<bool>,
}

/// The frames among `siblings` that carry `title`, and whether the toolkit
/// reports each one active. `None` when a frame's title or activity could not
/// be read, or `frame` is not among them: a count that is not known to be
/// complete proves nothing about which window is which.
pub(crate) fn twins_among(
    siblings: &[Sibling],
    frame: &AtspiElement,
    title: &str,
) -> Option<Twins> {
    let mut active = Vec::new();
    let mut me = None;
    for sibling in siblings {
        if sibling.title.as_deref()? != title {
            continue;
        }
        if sibling.bus_name == frame.bus_name() && sibling.path == frame.path() {
            me = Some(active.len());
        }
        active.push(sibling.active?);
    }
    Some(Twins { active, me: me? })
}

/// Reads every top-level frame of the application of `frame` and keeps those
/// that carry `title`. `None` when the frames cannot all be read.
pub(crate) async fn read_twins(
    connection: &Connection,
    frame: &AtspiElement,
    title: &str,
) -> Option<Twins> {
    let root = AtspiElement::new(frame.bus_name(), REGISTRY_ROOT_PATH, frame.pid());
    let children = list_children(connection, &root).await.ok()?;
    let mut siblings = Vec::with_capacity(children.len());
    for (bus_name, path) in children {
        let element = AtspiElement::new(bus_name.clone(), path.clone(), frame.pid());
        let (node, _) = read_node_for(connection, &element, ReadPurpose::Frame)
            .await
            .ok()?;
        siblings.push(Sibling {
            bus_name,
            path,
            title: node.properties.name.present().cloned(),
            active: frame_state(&node.traits.states).active,
        });
    }
    twins_among(&siblings, frame, title)
}

#[cfg(test)]
#[path = "twin_frames_tests.rs"]
mod tests;
