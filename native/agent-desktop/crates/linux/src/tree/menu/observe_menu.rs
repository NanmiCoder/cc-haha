use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ObservationRequest, ObservationRoot, ObservationSource,
    ObservedTree, SnapshotSurface, WindowInfo,
};

use super::menu_identity::MenuIdentity;
use crate::system::SharedBus;
use crate::system::menu::menu_surface::{MenuPopup, popups_of};
use crate::tree::element::ancestry;
use crate::tree::placement::node_position::place_nodes;
use crate::tree::properties::read_purpose::ReadPurpose;
use crate::tree::vocabulary::role_numbers::is_bulk_container;
use crate::tree::walk::walker::{walk_structure, walk_tree};
use crate::tree::{AtspiElement, ObservedRead, WalkLimits, WalkedNode};

/// An element that is the root of its own walk: it is its own frame, so the
/// refs below it resolve against it and not against a window.
pub(crate) fn rooted(element: &AtspiElement) -> AtspiElement {
    let mut root = element.clone();
    root.set_ancestry(ancestry::of_root(element));
    root
}

/// Walks up to `max_nodes` nodes below `root`, with the ordinary reads.
pub(crate) fn scan_walk(
    bus: &SharedBus,
    root: &AtspiElement,
    max_nodes: usize,
    deadline: Deadline,
) -> Result<WalkedNode<ObservedRead>, AdapterError> {
    let limits = WalkLimits {
        max_nodes,
        ..WalkLimits::default()
    };
    walk_tree(bus, root, &limits, deadline).map(|walk| walk.root)
}

pub(crate) const BULK_CHILDREN: usize = 48;

/// The structural walk of `scan_walk` or, with `bulk_children`, of
/// `scan_walk_pruned`, reading only what an inventory of surfaces classifies.
pub(crate) fn scan_walk_structure(
    bus: &SharedBus,
    root: &AtspiElement,
    max_nodes: usize,
    bulk_children: Option<usize>,
    deadline: Deadline,
) -> Result<WalkedNode<ObservedRead>, AdapterError> {
    let defaults = WalkLimits::default();
    let limits = WalkLimits {
        max_nodes,
        bulk_children: bulk_children.unwrap_or(defaults.bulk_children),
        ..defaults
    };
    walk_structure(bus, root, &limits, deadline, ReadPurpose::Structure).map(|walk| walk.root)
}

/// Walks up to `max_nodes` nodes below `root` and reads at most a few dozen
/// children of any one list, table or tree. The popup of a menu is never one of the many
/// rows of a list or the many cells of a table, so a container with
/// thousands of rows does not use up the budget before the walk reaches the
/// menu. A container cut this way is reported by [`is_pruned`].
pub(crate) fn scan_walk_pruned(
    bus: &SharedBus,
    root: &AtspiElement,
    max_nodes: usize,
    deadline: Deadline,
) -> Result<WalkedNode<ObservedRead>, AdapterError> {
    let limits = WalkLimits {
        max_nodes,
        bulk_children: BULK_CHILDREN,
        ..WalkLimits::default()
    };
    walk_tree(bus, root, &limits, deadline).map(|walk| walk.root)
}

/// Whether a node is a list, table or tree whose rows were cut at the child
/// limit on purpose, as opposed to a read that stopped short.
pub(crate) fn is_pruned(node: &WalkedNode<ObservedRead>) -> bool {
    node.truncated
        && is_bulk_container(node.payload.node.traits.role.present().copied())
        && node.children.len() == BULK_CHILDREN
        && node
            .child_count
            .is_some_and(|total| usize::try_from(total).is_ok_and(|total| total > BULK_CHILDREN))
}

/// Whether any part of the walk stopped short other than the rows pruned on
/// purpose.
pub(crate) fn is_cut_short_beyond_pruning(node: &WalkedNode<ObservedRead>) -> bool {
    (node.truncated && !is_pruned(node)) || node.children.iter().any(is_cut_short_beyond_pruning)
}

fn menu_absent() -> AdapterError {
    AdapterError::new(
        ErrorCode::ElementNotFound,
        "The window does not present an open menu",
    )
    .with_suggestion("Open the menu first, then snapshot the menu surface")
}

fn outermost(popups: Vec<MenuPopup>) -> Result<MenuPopup, AdapterError> {
    popups.into_iter().next().ok_or_else(menu_absent)
}

/// Snapshots the open menu of a window as an observed tree rooted at the
/// popup frame, so the refs below it resolve against the menu and not the
/// window.
pub(crate) fn observe_menu(
    bus: &SharedBus,
    window: &WindowInfo,
    request: &ObservationRequest,
) -> Result<ObservedTree, AdapterError> {
    let request = (*request).validate()?;
    let popups = popups_of(bus, window, request.deadline)?;
    let popup = outermost(popups)?;
    let mut root = rooted(&popup.root);
    let (owner_bus, owner_path) = crate::system::window::window_id::decode(&window.id)?;
    root.set_menu_owner(&AtspiElement::new(owner_bus, owner_path, window.pid.get()));
    let limits = WalkLimits {
        root_in_web: false,
        ..WalkLimits::for_request(&request)
    };
    let started = std::time::Instant::now();
    use crate::system::x11::{self, MonitorReader, MonitorSource};
    let displays = x11::start(|| MonitorReader.read());
    let mut walk = walk_tree(bus, &root, &limits, request.deadline)?;
    let context = popup.context.clone();
    place_nodes(bus, &mut walk, request.deadline)?;
    let complete = walk.complete;
    let displays = match displays.finish(request.deadline.capped(std::time::Duration::ZERO)) {
        Some(Ok(monitors)) => Some(
            monitors
                .into_iter()
                .map(|monitor| monitor.bounds)
                .collect::<Vec<_>>(),
        ),
        _ => None,
    };
    let (subtree, mut stats) = crate::tree::observe::projection::project_with(
        walk,
        &limits,
        &mut MenuIdentity::new(context),
        displays.as_deref(),
    );
    stats.reads.health.deadline_exhausted += u64::from(!complete && request.deadline.is_expired());
    stats.elapsed_us = u64::try_from(started.elapsed().as_micros()).unwrap_or(u64::MAX);
    let observation = ObservationRoot::Window(window);
    ObservedTree::from_roots(
        vec![subtree],
        ObservationSource::from_root(&observation, SnapshotSurface::Menu),
        stats,
        complete,
    )
}

#[cfg(test)]
#[path = "observe_menu_tests.rs"]
mod tests;
