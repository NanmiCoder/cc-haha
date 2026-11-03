use agent_desktop_core::{AdapterError, Deadline, ErrorCode, ObservedSubtree};

use super::item;
use super::menu_layout;
use super::node_evidence::{ITEM_ROLE, fresh, item_states};
use super::tray_item::TrayItem;
use super::{TrayTarget, call, capability, menu_nodes, registration, watcher};

/// One read of every item the watcher lists, with identity, capabilities and
/// menu, without inferring a native widget from its title.
pub(crate) struct TrayView {
    pub(crate) items: Vec<TrayItem>,
}

fn item_target(owner: String, object_path: String) -> TrayTarget {
    TrayTarget {
        owner,
        object_path,
        menu_path: None,
        entry_id: None,
        label_path: Vec::new(),
    }
}

fn describe(
    connection: &zbus::Connection,
    target: TrayTarget,
    deadline: Deadline,
) -> Result<TrayItem, AdapterError> {
    let evidence = item::read(connection, &target, deadline)?;
    let layout = evidence
        .menu
        .as_deref()
        .map(|menu| menu_layout::read(connection, &target.owner, menu, deadline))
        .transpose()?;
    Ok(TrayItem {
        target,
        evidence,
        layout,
    })
}

pub(crate) fn read(deadline: Deadline) -> Result<TrayView, AdapterError> {
    let listed = watcher::registered_items(deadline)?;
    let connection = call::session(deadline)?;
    let mut items: Vec<TrayItem> = Vec::new();
    for registered in registration::parse_all(&listed) {
        let Some(owner) = call::unique_owner(&connection, &registered.bus_name, deadline)? else {
            continue;
        };
        let known = items.iter().any(|item| {
            item.target.owner == owner && item.target.object_path == registered.object_path
        });
        if known {
            continue;
        }
        match describe(
            &connection,
            item_target(owner, registered.object_path),
            deadline,
        ) {
            Ok(item) => items.push(item),
            Err(error) if error.code == ErrorCode::StaleRef => {}
            Err(error) => return Err(error),
        }
    }
    Ok(TrayView { items })
}

fn menu_children(item: &TrayItem, first_index: usize) -> Vec<ObservedSubtree> {
    let (Some(layout), Some(menu)) = (&item.layout, &item.evidence.menu) else {
        return Vec::new();
    };
    menu_nodes::subtrees(&item.target, menu, layout)
        .into_iter()
        .enumerate()
        .map(|(offset, node)| node.with_source_child_index(first_index + offset))
        .collect()
}

impl TrayView {
    /// Watcher identities and menus, with no inferred native placement.
    pub(crate) fn subtrees(&self) -> Vec<ObservedSubtree> {
        self.items
            .iter()
            .map(|item| {
                let evidence = fresh(
                    ITEM_ROLE,
                    &item.evidence.title,
                    &item.target,
                    item_states(item.evidence.passive, Vec::new()),
                    capability::actions(&item.evidence.methods),
                );
                ObservedSubtree::new(evidence, menu_children(item, 0), true, None)
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "read_tests.rs"]
mod read_tests;
