use super::{arena::TraversalArena, child_read::ChildRead, node_read::read_node};
use crate::tree::AXElement;
use agent_desktop_core::{
    AdapterError, ErrorCode, ObservationRequest, ObservationSource, ObservedSubtree, ObservedTree,
};
use serde_json::json;
use std::time::{Duration, Instant};

pub(crate) struct LocatorTraversal {
    request: ObservationRequest,
    context: crate::tree::TreeBuildContext,
    deadline: Instant,
    arena: TraversalArena,
    usage: crate::tree::observation_usage::ObservationUsage,
}

impl LocatorTraversal {
    pub(crate) fn new(
        request: &ObservationRequest,
        context: crate::tree::TreeBuildContext,
        deadline: Instant,
    ) -> Self {
        Self {
            request: *request,
            context,
            deadline,
            arena: TraversalArena::new(),
            usage: crate::tree::observation_usage::ObservationUsage::new(request.budget),
        }
    }

    pub(crate) fn build(
        mut self,
        root: AXElement,
        source: ObservationSource,
    ) -> Result<(ObservedTree, bool, agent_desktop_core::LocatorStats), AdapterError> {
        self.arena.add_handles(1);
        let root = self.visit(root, 0, 0)?;
        let complete = self.arena.structurally_complete;
        let renderer_ready = self.arena.stats.activation.ready;
        let stats = self.arena.finish()?;
        let root = root.ok_or_else(|| {
            let code = if stats.reads.health.deadline_exhausted > 0 {
                ErrorCode::Timeout
            } else {
                ErrorCode::AppUnresponsive
            };
            AdapterError::new(
                code,
                "Accessibility observation ended before reading its root",
            )
            .with_details(json!({
                "kind": "observation_root_incomplete",
                "complete": false,
                "query_stats": stats,
            }))
        })?;
        let tree = ObservedTree::from_roots(vec![root], source, stats.clone(), complete)?;
        Ok((tree, renderer_ready, stats))
    }

    fn visit(
        &mut self,
        element: AXElement,
        logical_depth: u8,
        raw_depth: u8,
    ) -> Result<Option<ObservedSubtree>, AdapterError> {
        let Some(_) = self.remaining_budget() else {
            self.note_deadline_exhausted();
            self.arena.drop_handles(1);
            return Ok(None);
        };
        let pointer = element.0 as usize;
        if !self.arena.ancestors.insert(pointer) {
            self.arena.stats.traversal.cycles_skipped += 1;
            self.arena.drop_handles(1);
            return Ok(None);
        }
        if !self.usage.claim_node() {
            self.arena.stats.traversal.limits.node_hits += 1;
            self.arena.mark_incomplete();
            self.arena.ancestors.remove(&pointer);
            self.arena.drop_handles(1);
            return Ok(None);
        }
        self.note_visit(logical_depth, raw_depth);
        let requirements = self.request.evidence_for_raw_depth(raw_depth);
        let boundary_elements = boundary_label_elements(self.request, raw_depth);
        let child_plan = super::child_read_plan::ChildReadPlan::boundary_aware(
            self.usage.child_capacity(),
            boundary_elements,
            logical_depth,
            self.request.max_logical_depth,
        );
        let mut read = read_node(
            &element,
            super::node_read_context::NodeReadContext {
                tree: &self.context,
                stats: &mut self.arena.stats,
                usage: &mut self.usage,
                requirements,
                deadline: self.deadline,
                child_plan,
            },
        )?;
        let renderer_surface_observed = read
            .evidence
            .role
            .known()
            .is_some_and(|role| role == "webarea");
        if renderer_surface_observed {
            self.arena.stats.activation.ready = true;
        }
        if read.invalid_element {
            self.arena.ancestors.remove(&pointer);
            self.arena.drop_handles(1);
            if raw_depth == 0 {
                return Err(AdapterError::new(
                    ErrorCode::StaleRef,
                    "Live locator root is no longer a valid accessibility element",
                )
                .with_suggestion("Refresh the source snapshot and retry the locator")
                .with_details(json!({ "kind": "locator_root_invalid" })));
            }
            self.arena.mark_incomplete();
            return Ok(None);
        }
        let child_logical_depth = logical_depth + u8::from(!read.web_wrapper);
        if read.web_wrapper {
            self.arena.stats.traversal.web_wrapper_nodes += 1;
        }
        self.usage
            .note_child_demand(read.child_read.total_count, &mut self.arena.stats);
        let loaded_child_count = read.child_read.elements.len();
        self.arena.add_handles(loaded_child_count);
        let at_requested_boundary = child_logical_depth > self.request.max_logical_depth;
        let (children, children_count, subtree_complete) = if at_requested_boundary {
            self.arena.drop_handles(loaded_child_count);
            (
                Vec::new(),
                u32::try_from(read.child_read.total_count)
                    .ok()
                    .filter(|count| *count > 0),
                read.child_read.complete,
            )
        } else {
            self.usage.claim_edges(loaded_child_count);
            let original_viewport = self.context.window_bounds;
            self.context.window_bounds = crate::tree::element_bounds::clipped_viewport(
                original_viewport,
                read.attrs.role.as_deref().unwrap_or(""),
                read.attrs.bounds,
            );
            let result = self.visit_children(read.child_read, (child_logical_depth, raw_depth));
            self.context.window_bounds = original_viewport;
            let (children, complete) = result?;
            (children, None, complete)
        };
        self.arena.ancestors.remove(&pointer);
        self.arena.drop_handles(1);
        if !subtree_complete {
            self.arena.mark_incomplete();
        }
        if let Some(token) = crate::tree::resolve::retained::capture(&element)? {
            read.evidence.identifiers = read.evidence.identifiers.with_retained_object(token);
        }
        Ok(Some(ObservedSubtree::new(
            read.evidence,
            children,
            subtree_complete,
            children_count,
        )))
    }

    fn visit_children(
        &mut self,
        read: ChildRead,
        depths: (u8, u8),
    ) -> Result<(Vec<ObservedSubtree>, bool), AdapterError> {
        let mut complete = read.complete && !read.truncated();
        if !complete {
            self.arena.mark_incomplete();
        }
        if depths.1 >= self.request.max_raw_depth && !read.elements.is_empty() {
            self.arena.stats.traversal.limits.depth_hits += 1;
            self.arena.drop_handles(read.elements.len());
            self.arena.mark_incomplete();
            return Ok((Vec::new(), false));
        }
        let total = read.elements.len();
        let mut children = Vec::new();
        let mut predecessors_complete = read.prefix_certain;
        for (child_index, child) in read.elements.into_iter().enumerate() {
            if self.remaining_budget().is_none() {
                self.note_deadline_exhausted();
                self.arena.drop_handles(total.saturating_sub(child_index));
                complete = false;
                break;
            }
            match self.visit(child, depths.0, depths.1.saturating_add(1))? {
                Some(subtree) => {
                    complete &= subtree.is_complete();
                    let edge_complete = retained_edge_certainty(&mut predecessors_complete, true);
                    children.push(
                        subtree
                            .with_source_child_index(child_index)
                            .with_predecessors_complete(edge_complete),
                    );
                }
                None => {
                    complete = false;
                    retained_edge_certainty(&mut predecessors_complete, false);
                }
            }
        }
        if !complete {
            self.arena.mark_incomplete();
        }
        Ok((children, complete))
    }

    fn remaining_budget(&self) -> Option<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .map(|remaining| remaining.min(crate::tree::locator_deadline::MAX_IPC_SLICE))
            .filter(|remaining| !remaining.is_zero())
    }

    fn note_deadline_exhausted(&mut self) {
        self.arena.stats.reads.health.deadline_exhausted += 1;
        self.arena.mark_incomplete();
    }

    fn note_visit(&mut self, logical_depth: u8, raw_depth: u8) {
        self.arena.stats.traversal.nodes_visited += 1;
        self.arena.stats.traversal.max_logical_depth = self
            .arena
            .stats
            .traversal
            .max_logical_depth
            .max(logical_depth);
        self.arena.stats.traversal.max_raw_depth =
            self.arena.stats.traversal.max_raw_depth.max(raw_depth);
    }
}

fn retained_edge_certainty(prefix_certain: &mut bool, retained: bool) -> bool {
    let edge_certain = *prefix_certain;
    *prefix_certain &= retained;
    edge_certain
}

/// How many children a node at the depth boundary may load purely to compute
/// its own name from child content. A selected locator root hydrates this way
/// only at its own boundary; a skeleton observation clamps depth everywhere,
/// so every boundary node in the walk needs the same chance to name itself,
/// not only the root.
fn boundary_label_elements(request: ObservationRequest, raw_depth: u8) -> usize {
    let hydrates_selected_root = raw_depth == 0 && request.hydrates_root_name_from_children();
    if hydrates_selected_root || request.observation_mode.skeleton {
        crate::tree::child_labels::MAX_LABEL_ELEMENTS
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omitted_child_cannot_leave_its_parent_subtree_complete() {
        let mut request = ObservationRequest::snapshot(
            &agent_desktop_core::TreeOptions::default(),
            agent_desktop_core::Deadline::after(1_000).unwrap(),
        );
        request.budget.max_nodes = 1;
        let mut traversal = LocatorTraversal::new(
            &request,
            crate::tree::TreeBuildContext::empty(false),
            Instant::now() + Duration::from_secs(1),
        );
        assert!(traversal.usage.claim_node());
        traversal.arena.add_handles(1);
        let mut read = ChildRead::empty(true);
        read.elements.push(AXElement(std::ptr::null_mut()));
        read.total_count = 1;

        let (children, complete) = traversal.visit_children(read, (1, 0)).unwrap();

        assert!(children.is_empty());
        assert!(!complete);
        assert!(!traversal.arena.structurally_complete);
        assert!(traversal.arena.finish().is_ok());
    }

    #[test]
    fn uncertain_source_prefix_marks_retained_edge_uncertain() {
        let mut prefix_certain = false;

        assert!(!retained_edge_certainty(&mut prefix_certain, true));
    }

    #[test]
    fn omitted_native_predecessor_marks_later_retained_edge_uncertain() {
        let mut prefix_certain = true;

        assert!(retained_edge_certainty(&mut prefix_certain, false));
        assert!(!retained_edge_certainty(&mut prefix_certain, true));
    }

    fn skeleton_request() -> ObservationRequest {
        ObservationRequest::snapshot(
            &agent_desktop_core::TreeOptions {
                skeleton: true,
                ..agent_desktop_core::TreeOptions::default()
            },
            agent_desktop_core::Deadline::after(1_000).unwrap(),
        )
    }

    #[test]
    fn skeleton_boundary_nodes_request_label_children_at_any_depth() {
        let request = skeleton_request();

        assert_eq!(
            boundary_label_elements(request, 0),
            crate::tree::child_labels::MAX_LABEL_ELEMENTS
        );
        assert_eq!(
            boundary_label_elements(request, 2),
            crate::tree::child_labels::MAX_LABEL_ELEMENTS
        );
    }

    #[test]
    fn non_skeleton_snapshot_only_hydrates_a_selected_root_not_every_boundary() {
        let request = ObservationRequest::snapshot(
            &agent_desktop_core::TreeOptions::default(),
            agent_desktop_core::Deadline::after(1_000).unwrap(),
        );

        assert_eq!(boundary_label_elements(request, 0), 0);
        assert_eq!(boundary_label_elements(request, 2), 0);
    }
}
