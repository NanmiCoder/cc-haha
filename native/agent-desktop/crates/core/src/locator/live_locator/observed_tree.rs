use serde_json::json;

use crate::{AccessibilityNode, AdapterError, ErrorCode, refs::RefPath};

use super::{LocatorStats, ObservationSource, ObservedNode, ObservedSubtree};

#[derive(Debug, Clone)]
pub struct ObservedTree {
    pub(crate) nodes: Vec<ObservedNode>,
    pub(crate) roots: Vec<u32>,
    pub(crate) source: ObservationSource,
    pub(crate) stats: LocatorStats,
    pub(crate) structurally_complete: bool,
}

impl ObservedTree {
    pub fn from_roots(
        roots: Vec<ObservedSubtree>,
        source: ObservationSource,
        stats: LocatorStats,
        structurally_complete: bool,
    ) -> Result<Self, AdapterError> {
        if roots.is_empty() {
            return Err(AdapterError::internal("observation contains no roots"));
        }
        let mut tree = Self {
            nodes: Vec::new(),
            roots: Vec::new(),
            source,
            stats,
            structurally_complete,
        };
        for root in roots {
            let index = tree.append(root, RefPath::new())?;
            tree.roots.push(index);
        }
        tree.structurally_complete &= tree
            .roots
            .iter()
            .all(|root| tree.nodes[*root as usize].completeness.subtree_complete);
        Ok(tree)
    }

    pub fn is_complete(&self) -> bool {
        self.structurally_complete
    }

    pub fn into_accessibility_tree(mut self) -> Result<AccessibilityNode, AdapterError> {
        if !self.structurally_complete {
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                "Accessibility observation was incomplete",
            )
            .with_suggestion("Retry with a larger timeout or a narrower tree depth")
            .with_details(json!({
                "kind": "observation_incomplete",
                "nodes_observed": self.nodes.len(),
                "query_stats": self.stats,
            })));
        }
        if self.roots.len() != 1 {
            return Err(AdapterError::internal(
                "accessibility projection requires exactly one root",
            ));
        }
        self.project(self.roots[0] as usize)
    }

    /// Projects whatever was observed and reports its completeness, rather than
    /// discarding an entire walk because the budget expired before the last
    /// node. Callers that need an all-or-nothing tree keep using
    /// `into_accessibility_tree`. The observation layer already annotates each
    /// truncated container with `children_count`, so a partial tree stays
    /// honest about its own boundaries.
    pub fn into_accessibility_tree_partial(
        mut self,
    ) -> Result<(AccessibilityNode, bool, usize), AdapterError> {
        if self.roots.len() != 1 {
            return Err(AdapterError::internal(
                "accessibility projection requires exactly one root",
            ));
        }
        let complete = self.structurally_complete;
        let nodes_observed = self.nodes.len();
        let tree = self.project(self.roots[0] as usize)?;
        Ok((tree, complete, nodes_observed))
    }

    fn append(&mut self, subtree: ObservedSubtree, path: RefPath) -> Result<u32, AdapterError> {
        let index = u32::try_from(self.nodes.len())
            .map_err(|_| AdapterError::internal("observed tree exceeds u32"))?;
        let document_order = index;
        let ObservedSubtree {
            evidence,
            children,
            completeness,
            children_count,
            source_child_index: _,
        } = subtree;
        self.nodes.push(ObservedNode {
            evidence,
            path: path.clone(),
            children: Vec::new(),
            document_order,
            completeness,
            children_count,
            ref_id: None,
        });
        let mut child_indices = Vec::with_capacity(children.len());
        let mut complete = completeness.subtree_complete;
        let mut previous_native_index = None;
        for (child_order, child) in children.into_iter().enumerate() {
            let native_index = child.source_child_index.unwrap_or(child_order);
            if previous_native_index.is_some_and(|previous| previous >= native_index) {
                return Err(AdapterError::internal(
                    "locator tree children are not in native document order",
                ));
            }
            previous_native_index = Some(native_index);
            let mut child_path = path.clone();
            child_path.push(native_index);
            let child_index = self.append(child, child_path)?;
            complete &= self.nodes[child_index as usize]
                .completeness
                .subtree_complete;
            child_indices.push(child_index);
        }
        let node = self
            .nodes
            .get_mut(index as usize)
            .ok_or_else(|| AdapterError::internal("observed node disappeared during build"))?;
        node.children = child_indices;
        node.completeness.subtree_complete = complete;
        Ok(index)
    }

    fn project(&mut self, index: usize) -> Result<AccessibilityNode, AdapterError> {
        let node = self
            .nodes
            .get_mut(index)
            .ok_or_else(|| AdapterError::internal("observed child index is out of bounds"))?;
        let role = node
            .evidence
            .role
            .take_known()
            .unwrap_or_else(|| "unknown".into());
        let child_indices = std::mem::take(&mut node.children);
        let mut projected = AccessibilityNode {
            ref_id: node.ref_id.take(),
            role,
            identity: crate::NodeIdentity {
                retained_object: node
                    .evidence
                    .identifiers
                    .retained_object()
                    .map(str::to_owned),
                name: node
                    .evidence
                    .name
                    .take_known()
                    .filter(|value| !value.is_empty()),
                value: node
                    .evidence
                    .value
                    .take_known()
                    .filter(|value| !value.is_empty()),
                description: node
                    .evidence
                    .description
                    .take_known()
                    .filter(|value| !value.is_empty()),
                native_id: node.evidence.identifiers.preferred_identifier().cloned(),
            },
            presentation: crate::NodePresentation {
                hint: None,
                states: node.evidence.states.take_known().unwrap_or_default(),
                available_actions: node
                    .evidence
                    .ref_evidence
                    .available_actions
                    .take_known()
                    .unwrap_or_default(),
                bounds: node.evidence.ref_evidence.bounds.known().copied(),
                ref_bounds: node.evidence.ref_evidence.window_bounds.known().copied(),
                descriptors: node.evidence.ref_evidence.descriptors.clone(),
            },
            children_count: node.children_count,
            subtree_truncated: !node.completeness.subtree_complete,
            children: Vec::with_capacity(child_indices.len()),
        };
        for child in child_indices {
            projected.children.push(self.project(child as usize)?);
        }
        Ok(projected)
    }
}
