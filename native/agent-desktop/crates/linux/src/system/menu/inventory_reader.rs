use super::menu_popup::{Node, is_popup_candidate, only_menu_content};
use super::menu_surface::{PopupReader, popup_read_complete, vanished};
use crate::system::{REGISTRY_ROOT_PATH, SharedBus, within};
use crate::tree::menu::observe_menu::{
    BULK_CHILDREN, is_cut_short_beyond_pruning, rooted, scan_walk, scan_walk_pruned,
    scan_walk_structure,
};
use crate::tree::surfaces::top_level::is_popup_menu_candidate;
use crate::tree::{AtspiElement, list_children, read_node};
use agent_desktop_core::{AdapterError, Deadline};
use std::collections::HashMap;

const WINDOW_NODES: usize = 2000;
const TOP_LEVEL_NODES: usize = 80;

#[derive(Debug, PartialEq, Eq)]
enum ScanKind {
    Ordinary,
    Pruned,
    Structural { bulk_children: Option<usize> },
}

fn scan_kind(structural: bool, pruned: bool) -> ScanKind {
    match (structural, pruned) {
        (true, _) => ScanKind::Structural {
            bulk_children: pruned.then_some(BULK_CHILDREN),
        },
        (false, true) => ScanKind::Pruned,
        (false, false) => ScanKind::Ordinary,
    }
}

pub(in crate::system) struct Inventory<'a> {
    bus: &'a SharedBus,
    deadline: Deadline,
    window: Option<AtspiElement>,
    trees: HashMap<(String, String), Result<Node, AdapterError>>,
    top_levels: HashMap<String, (Vec<Node>, bool)>,
    incomplete: bool,
    structural: bool,
}

impl<'a> Inventory<'a> {
    pub(in crate::system) fn new(bus: &'a SharedBus, deadline: Deadline) -> Self {
        Self {
            bus,
            deadline,
            window: None,
            trees: HashMap::new(),
            top_levels: HashMap::new(),
            incomplete: false,
            structural: false,
        }
    }

    /// An inventory that reads only what classifying surfaces needs, for a
    /// listing that never keeps a node's identity.
    pub(in crate::system) fn structural(bus: &'a SharedBus, deadline: Deadline) -> Self {
        Self {
            structural: true,
            ..Self::new(bus, deadline)
        }
    }

    fn walk(
        &self,
        root: &AtspiElement,
        max_nodes: usize,
        pruned: bool,
    ) -> Result<Node, AdapterError> {
        let root = rooted(root);
        match scan_kind(self.structural, pruned) {
            ScanKind::Structural { bulk_children } => {
                scan_walk_structure(self.bus, &root, max_nodes, bulk_children, self.deadline)
            }
            ScanKind::Pruned => scan_walk_pruned(self.bus, &root, max_nodes, self.deadline),
            ScanKind::Ordinary => scan_walk(self.bus, &root, max_nodes, self.deadline),
        }
    }

    pub(in crate::system) fn select(&mut self, window: &AtspiElement) {
        self.window = Some(window.clone());
        self.incomplete = false;
    }

    pub(in crate::system) fn read(&mut self, window: &AtspiElement) -> Result<Node, AdapterError> {
        let key = (window.bus_name().to_owned(), window.path().to_owned());
        if !self.trees.contains_key(&key) {
            let tree = self.walk(window, WINDOW_NODES, false);
            self.trees.insert(key.clone(), tree);
        }
        self.trees[&key].clone()
    }

    /// Structural walks omit interfaces; retain the root's measured Component
    /// evidence so an actual context menu stays classifiable (L41-26).
    fn top(&mut self, window: &AtspiElement) -> Result<(Vec<Node>, bool), AdapterError> {
        let key = window.bus_name().to_owned();
        if let Some(cached) = self.top_levels.get(&key) {
            return Ok(cached.clone());
        }
        let connection = self.bus.get(self.deadline)?;
        let root = AtspiElement::new(window.bus_name(), REGISTRY_ROOT_PATH, window.pid());
        let children = within(self.deadline, list_children(connection.inner(), &root))?;
        let mut found = Vec::new();
        let mut incomplete = false;
        for (bus_name, path) in children {
            let child = AtspiElement::new(bus_name, path, window.pid());
            let key = (child.bus_name().to_owned(), child.path().to_owned());
            if let Some(Ok(tree)) = self.trees.get(&key) {
                if !is_cut_short_beyond_pruning(tree)
                    && (!tree.payload.node.properties.name.is_blank()
                        || tree.payload.node.traits.interfaces.present().is_some())
                {
                    incomplete |= !popup_read_complete(tree);
                    if is_popup_candidate(tree) {
                        found.push(tree.clone());
                    }
                    continue;
                }
            }
            let node = match within(self.deadline, read_node(connection.inner(), &child)) {
                Ok(node) => node,
                Err(error) => {
                    incomplete |= !vanished(&error);
                    continue;
                }
            };
            if node.traits.interfaces.present().is_none()
                || node.traits.states.present().is_none()
                || node.properties.name.is_failed()
            {
                incomplete = true;
                continue;
            }
            if !is_popup_menu_candidate(&node) {
                continue;
            }
            match self.walk(&child, TOP_LEVEL_NODES, true) {
                Ok(mut tree) => {
                    tree.payload.node.traits.interfaces = node.traits.interfaces;
                    incomplete |= may_hide_a_menu(&tree) || !popup_read_complete(&tree);
                    if is_popup_candidate(&tree) {
                        found.push(tree);
                    }
                }
                Err(error) => incomplete |= !vanished(&error),
            }
        }
        self.top_levels
            .insert(window.bus_name().to_owned(), (found.clone(), incomplete));
        Ok((found, incomplete))
    }
}

/// Whether a top-level candidate was read only in part and what was read is
/// all menu content: an open menu may continue past where the read stopped.
/// A cut-short window holding anything else is not a popup whatever it hides.
fn may_hide_a_menu(candidate: &Node) -> bool {
    is_cut_short_beyond_pruning(candidate) && candidate.children.iter().all(only_menu_content)
}

impl PopupReader for Inventory<'_> {
    fn incomplete(&self) -> bool {
        self.incomplete
    }

    fn window(&mut self) -> Result<Option<Node>, AdapterError> {
        let window = self
            .window
            .as_ref()
            .ok_or_else(|| AdapterError::internal("No inventory window selected"))?;
        let key = (window.bus_name().to_owned(), window.path().to_owned());
        if let Some(Ok(tree)) = self.trees.get(&key) {
            if !crate::tree::surfaces::nested_dialog::is_incomplete(tree) {
                self.incomplete |= !popup_read_complete(tree);
                return Ok(Some(tree.clone()));
            }
        }
        let web = within(
            self.deadline,
            crate::tree::properties::toolkit_trust::read_web_family(
                self.bus.get(self.deadline)?.inner(),
                window,
            ),
        )?
        .is_some();
        if web {
            return Ok(None);
        }
        let tree = self.walk(window, WINDOW_NODES, true)?;
        self.incomplete |= is_cut_short_beyond_pruning(&tree) || !popup_read_complete(&tree);
        Ok(Some(tree))
    }

    fn top_levels(&mut self) -> Result<Vec<Node>, AdapterError> {
        let window = self
            .window
            .clone()
            .ok_or_else(|| AdapterError::internal("No inventory window selected"))?;
        let (all, incomplete) = self.top(&window)?;
        self.incomplete |= incomplete;
        Ok(all
            .into_iter()
            .filter(|node| {
                let element = &node.payload.node.element;
                !(element.bus_name() == window.bus_name() && element.path() == window.path())
            })
            .collect())
    }
}

#[cfg(test)]
#[path = "inventory_reader_tests.rs"]
mod tests;
