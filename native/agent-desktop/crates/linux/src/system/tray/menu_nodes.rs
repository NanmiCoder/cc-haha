use agent_desktop_core::{LocatorEvidence, ObservedSubtree, tree::state};

use super::TrayTarget;
use super::capability;
use super::menu_layout::{Layout, LayoutEntry};
use super::node_evidence::{ENTRY_ROLE, SEPARATOR_ROLE, fresh};

pub(crate) fn states_of(entry: &LayoutEntry) -> Vec<String> {
    let mut states = Vec::new();
    if !entry.enabled {
        states.push(state::DISABLED.to_owned());
    }
    if entry.checked == Some(true) {
        states.push(state::CHECKED.to_owned());
    }
    if entry.submenu {
        states.push(state::HASPOPUP.to_owned());
    }
    states
}

pub(crate) fn role_of(entry: &LayoutEntry) -> &'static str {
    if entry.separator {
        SEPARATOR_ROLE
    } else {
        ENTRY_ROLE
    }
}

fn evidence_of(entry: &LayoutEntry, target: &TrayTarget) -> LocatorEvidence {
    fresh(
        role_of(entry),
        &entry.label,
        target,
        states_of(entry),
        capability::entry_actions(entry),
    )
}

fn build(
    item: &TrayTarget,
    menu_path: &str,
    entries: &[LayoutEntry],
    labels: &[String],
) -> Vec<ObservedSubtree> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut path = labels.to_vec();
            path.push(entry.label.clone());
            let target = TrayTarget {
                menu_path: Some(menu_path.to_owned()),
                entry_id: Some(entry.id),
                label_path: path.clone(),
                ..item.clone()
            };
            let children = build(item, menu_path, &entry.children, &path);
            ObservedSubtree::new(evidence_of(entry, &target), children, true, None)
                .with_source_child_index(index)
        })
        .collect()
}

/// The entries of a tray item's menu as subtrees, each carrying the persisted
/// identity that names it: owner, object, menu, entry id and label path.
pub(crate) fn subtrees(
    item: &TrayTarget,
    menu_path: &str,
    layout: &Layout,
) -> Vec<ObservedSubtree> {
    build(item, menu_path, &layout.root.children, &[])
}

#[cfg(test)]
#[path = "menu_nodes_tests.rs"]
mod tests;
