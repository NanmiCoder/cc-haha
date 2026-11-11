use std::time::Duration;

use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use serde_json::json;

use super::anchor::Anchor;
use super::identity::ShellRoot;
use super::light::{Light, LiveNodes, Nodes};
use super::located::Located;
use super::search::{Visit, walk};
use crate::system::SharedBus;
use crate::tree::AtspiElement;
use crate::tree::vocabulary::role_numbers::{LABEL, PUSH_BUTTON, TOGGLE_BUTTON};

pub(crate) const MENU: u32 = 33;

const UNREAD_RETRIES: usize = 12;
const UNREAD_GAP: Duration = Duration::from_millis(100);
const LOST_NODE: &str = "A shell node left the tree or answered no role during the read";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Landmark {
    MessageList,
    TrayPanel,
    DockPanel,
    SystemMenu,
    DateMenu,
}

fn unproven(anchor: Anchor) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The shell exposes no structural identity for this container or its opener",
    )
    .with_suggestion("Use an app surface or a watcher-backed tray item; labels and positions cannot prove shell popup identity")
    .with_details(json!({ "kind": "shell_container_unproven", "landmark": format!("{anchor:?}") }))
    .with_disposition(DeliverySemantics::not_delivered())
}

fn lost_a_node(anchor: Anchor) -> AdapterError {
    unproven(anchor)
        .with_suggestion("Retry the command; the shell tree changed while it was read")
        .with_platform_detail(LOST_NODE)
}

fn locate_in<N: Nodes>(
    nodes: &N,
    root: &ShellRoot,
    anchor: Anchor,
    deadline: Deadline,
) -> Result<Located, AdapterError> {
    let start = AtspiElement::new(&root.bus_name, &root.path, root.pid);
    let (mut found, complete, many) = match anchor {
        Anchor::Landmark(Landmark::TrayPanel) => {
            let node = nodes.read(&start)?;
            return Ok(Located {
                anchor: node.clone(),
                container: node,
            });
        }
        Anchor::Landmark(Landmark::MessageList) => {
            let walked = walk(nodes, &start, deadline, &|_| false)?;
            (
                lists(&walked.visits),
                walked.complete,
                "Several shell containers have the requested role chain",
            )
        }
        Anchor::Landmark(Landmark::DateMenu) => {
            let walked = walk(nodes, &start, deadline, &|light| !light.showing)?;
            (
                date_menus(&walked.visits),
                walked.complete,
                "Several unnamed menus are showing in the shell",
            )
        }
        _ => return Err(unproven(anchor)),
    };
    match (found.len(), complete) {
        (0 | 1, false) => Err(lost_a_node(anchor)),
        (0, true) => Err(unproven(anchor)),
        (1, true) => {
            let light = found.remove(0);
            Ok(Located {
                anchor: light.clone(),
                container: light,
            })
        }
        _ => Err(AdapterError::ambiguous_target(many)),
    }
}

/// The list's footer is a row of a label, a toggle and a push button, in that
/// order, and the row sits one level below the container holding the
/// entries. The roles and the row's shape carry the identity, not any text.
fn lists(visits: &[Visit]) -> Vec<Light> {
    let footer = |row: &Visit| {
        let roles: Vec<u32> = row
            .children
            .iter()
            .map(|child| visits[*child].light.role)
            .collect();
        roles == [LABEL, TOGGLE_BUTTON, PUSH_BUTTON]
    };
    let mut found: Vec<usize> = Vec::new();
    for container in visits
        .iter()
        .filter(|row| footer(row))
        .filter_map(|row| row.parent)
    {
        if !found.contains(&container) {
            found.push(container);
        }
    }
    found
        .into_iter()
        .map(|index| visits[index].light.clone())
        .collect()
}

/// The date menu is the one showing menu in the shell with no accessible
/// name; every other top bar menu names its indicator.
fn date_menus(visits: &[Visit]) -> Vec<Light> {
    visits
        .iter()
        .map(|visit| &visit.light)
        .filter(|light| light.role == MENU && light.name.is_empty() && light.placed().is_some())
        .cloned()
        .collect()
}

/// Looks the anchor up again while a walk loses a node. A banner or a popup
/// that closes during one walk is gone from the next, so a walk that keeps
/// losing a node, past the retries or the deadline, is the one that refuses.
fn locate_settled<N: Nodes>(
    nodes: &N,
    root: &ShellRoot,
    anchor: Anchor,
    deadline: Deadline,
    pause: &mut dyn FnMut(Duration),
) -> Result<Located, AdapterError> {
    let mut tries = 0;
    loop {
        match locate_in(nodes, root, anchor, deadline) {
            Err(error)
                if error.platform_detail.as_deref() == Some(LOST_NODE)
                    && tries < UNREAD_RETRIES
                    && !deadline.is_expired() =>
            {
                tries += 1;
                pause(UNREAD_GAP);
            }
            other => return other,
        }
    }
}

pub(crate) fn locate_anchor(
    bus: &SharedBus,
    root: &ShellRoot,
    anchor: Anchor,
    deadline: Deadline,
) -> Result<Located, AdapterError> {
    let nodes = LiveNodes::new(bus.get(deadline)?.inner().clone(), deadline);
    locate_settled(&nodes, root, anchor, deadline, &mut std::thread::sleep)
}

#[cfg(test)]
#[path = "container_tests.rs"]
mod tests;
