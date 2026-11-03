use agent_desktop_core::{AdapterError, Deadline, LocatorStats, ObservedSubtree};
use serde_json::json;

use super::walker::{NodeKey, TreeSource, WalkBudget};
use crate::tree::automation::{UiaFailure, uia_failure_error};

/// How long a boundary node's child-count-only read gets, independent of the
/// walk's own deadline.
///
/// A boundary node is read for its child count alone, purely to annotate how
/// much was left unobserved: on a target that materialises children lazily,
/// that count is not cheap, and one such node could otherwise consume an
/// entire snapshot budget on a count nobody needs that badly. Mirrors macOS's
/// `BOUNDARY_COUNT_BUDGET` (`crates/macos/src/tree/query/child_read_budget.rs`,
/// the same 25ms value and rationale). The count stays best-effort: a starved
/// read yields no count while the boundary is still marked truncated, so the
/// two signals never contradict each other.
const BOUNDARY_COUNT_BUDGET: std::time::Duration = std::time::Duration::from_millis(25);

/// How many enumeration faults one walk reports.
///
/// A pathological target can fault on every node; the tree still records the
/// incompleteness for all of them, while the error list stays bounded so a
/// trace segment cannot be flooded from a single walk.
const MAX_REPORTED_FAILURES: usize = 8;

/// Which of the two enumeration calls faulted.
///
/// Typed rather than a string: the two axes behave differently against a dead
/// provider - descent surfaces `E_FAIL` while the sibling terminator is
/// indistinguishable from end-of-list (A14-4) - so a reader of a trace segment
/// needs to know which one this was, and a typo must not be able to change it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnumerationAxis {
    FirstChild,
    NextSibling,
}

impl EnumerationAxis {
    fn as_str(self) -> &'static str {
        match self {
            Self::FirstChild => "first_child",
            Self::NextSibling => "next_sibling",
        }
    }
}

/// One node's child list as the enumeration loop found it.
struct ChildRead<N> {
    elements: Vec<N>,
    complete: bool,
}

/// The traversal state for one walk.
///
/// `ancestors` is an ancestor path, never a global visited set: a global set
/// would prune a real sibling subtree that legitimately re-reaches the same
/// element by a different route.
pub struct TreeWalk<'a, S: TreeSource> {
    source: &'a S,
    budget: WalkBudget,
    ancestors: Vec<(NodeKey, S::Node)>,
    stats: LocatorStats,
    complete: bool,
    failures: Vec<AdapterError>,
    suppressed_failures: u32,
}

impl<'a, S: TreeSource> TreeWalk<'a, S> {
    pub fn new(source: &'a S, budget: WalkBudget) -> Self {
        Self {
            source,
            budget,
            ancestors: Vec::new(),
            stats: LocatorStats::default(),
            complete: true,
            failures: Vec::new(),
            suppressed_failures: 0,
        }
    }

    /// How many entries the ancestor path currently holds.
    ///
    /// Zero on every exit from a completed `visit`, including the exits taken
    /// when enumeration faults. A missed removal is the bug this guard ships
    /// with most easily, so it is observable rather than implied.
    #[cfg(test)]
    pub fn ancestor_depth(&self) -> usize {
        self.ancestors.len()
    }

    /// Visits one element and everything beneath it.
    ///
    /// The ancestor entry is pushed once here and popped once here, so every
    /// path out of the visited body — normal, budget-exhausted, or faulting —
    /// leaves the path exactly as it found it.
    pub fn visit(
        &mut self,
        node: S::Node,
        logical_depth: u8,
        raw_depth: u8,
    ) -> Option<ObservedSubtree> {
        if self.budget.deadline.ensure_remaining().is_err() {
            self.note_deadline_exhausted();
            return None;
        }
        let key = self.source.identity(&node);
        if self.is_ancestor(&key, &node) {
            self.stats.traversal.cycles_skipped += 1;
            return None;
        }
        self.ancestors.push((key, node.clone()));
        let subtree = self.visit_entered(&node, logical_depth, raw_depth);
        self.ancestors.pop();
        subtree
    }

    /// Reports the walk's accounting, refusing a run that leaked an ancestor
    /// entry rather than presenting its tree as trustworthy.
    pub fn finish(self) -> Result<(LocatorStats, bool, Vec<AdapterError>), AdapterError> {
        if !self.ancestors.is_empty() {
            return Err(AdapterError::internal(format!(
                "element tree walk retained {} ancestor entries",
                self.ancestors.len()
            )));
        }
        let mut failures = self.failures;
        if let Some(last) = failures.last_mut() {
            annotate_suppressed(last, self.suppressed_failures);
        }
        Ok((self.stats, self.complete, failures))
    }

    /// Visits one node: reads its evidence, resolves subtree depth by
    /// wrapper-ness, and reports its children. A boundary `children_count` is
    /// only real when the enumeration completed: a raw-depth boundary with the
    /// full sibling list read knows how many children it skipped, but a
    /// deadline- or sibling-cap-cut list has an unknowable count and marks the
    /// node without one.
    fn visit_entered(
        &mut self,
        node: &S::Node,
        logical_depth: u8,
        raw_depth: u8,
    ) -> Option<ObservedSubtree> {
        self.note_visit(logical_depth, raw_depth);
        let (properties, evidence, read_failures) = self.source.evidence(node);
        self.stats.reads.counts.observation_attempts += 1;
        self.stats.reads.health.native_read_failures += read_failures;
        let web_wrapper = self.source.is_web_wrapper(node, &properties);
        if web_wrapper {
            self.stats.traversal.web_wrapper_nodes += 1;
        }
        let child_logical_depth = logical_depth.saturating_add(u8::from(!web_wrapper));
        if self.budget.deadline.ensure_remaining().is_err() {
            self.note_deadline_exhausted();
            return None;
        }
        let boundary_candidate = raw_depth >= self.budget.max_raw_depth
            || child_logical_depth > self.budget.max_logical_depth;
        let read_deadline = if boundary_candidate {
            self.budget.deadline.capped(BOUNDARY_COUNT_BUDGET)
        } else {
            self.budget.deadline
        };
        let read = self.read_children(node, raw_depth, read_deadline);
        let truncated_by_raw_depth =
            raw_depth >= self.budget.max_raw_depth && !read.elements.is_empty();
        let at_boundary =
            truncated_by_raw_depth || child_logical_depth > self.budget.max_logical_depth;
        let (children, children_count, subtree_complete) = if at_boundary {
            if truncated_by_raw_depth {
                self.stats.traversal.limits.depth_hits += 1;
            }
            let count = read
                .complete
                .then(|| u32::try_from(read.elements.len()).ok().filter(|c| *c > 0))
                .flatten();
            (Vec::new(), count, read.complete && !truncated_by_raw_depth)
        } else {
            let (children, complete) = self.visit_children(read, (child_logical_depth, raw_depth));
            (children, None, complete)
        };
        if !subtree_complete {
            self.complete = false;
        }
        Some(ObservedSubtree::new(
            evidence,
            children,
            subtree_complete,
            children_count,
        ))
    }

    /// The child enumeration loop.
    ///
    /// Written directly on `first_child` / `next_sibling` because the crate's
    /// own `while let Ok(next) = self.next_sibling(&current)` retires
    /// end-of-siblings and a cross-process RPC fault through the same arm,
    /// which turns a hung target into a truncated tree that reports complete.
    /// Every `Err` is classified on the measured pair instead: an exhaustion
    /// failure ends the list and leaves the subtree complete, anything else
    /// marks it incomplete and surfaces a structured error.
    ///
    /// `deadline` is the caller's choice, not always `self.budget.deadline`:
    /// a boundary node's read is clamped to `BOUNDARY_COUNT_BUDGET` because it
    /// only ever produces a count, never a subtree to visit.
    fn read_children(
        &mut self,
        node: &S::Node,
        raw_depth: u8,
        deadline: Deadline,
    ) -> ChildRead<S::Node> {
        let mut elements = Vec::new();
        let mut complete = true;
        match self.source.first_child(node) {
            Ok(first) => {
                let mut current = first;
                loop {
                    if elements.len() >= self.budget.max_siblings {
                        self.stats.traversal.limits.child_hits += 1;
                        complete = false;
                        break;
                    }
                    if deadline.ensure_remaining().is_err() {
                        self.note_deadline_exhausted();
                        complete = false;
                        break;
                    }
                    let next = self.source.next_sibling(&current);
                    elements.push(current);
                    match next {
                        Ok(sibling) => current = sibling,
                        Err(failure) if failure.is_exhaustion() => break,
                        Err(failure) => {
                            self.record(
                                failure,
                                EnumerationAxis::NextSibling,
                                raw_depth,
                                elements.len(),
                            );
                            complete = false;
                            break;
                        }
                    }
                }
            }
            Err(failure) if failure.is_exhaustion() => {}
            Err(failure) => {
                self.record(failure, EnumerationAxis::FirstChild, raw_depth, 0);
                complete = false;
            }
        }
        ChildRead { elements, complete }
    }

    fn visit_children(
        &mut self,
        read: ChildRead<S::Node>,
        depths: (u8, u8),
    ) -> (Vec<ObservedSubtree>, bool) {
        let mut complete = read.complete;
        let mut children = Vec::new();
        let mut predecessors_complete = true;
        for (child_index, child) in read.elements.into_iter().enumerate() {
            match self.visit(child, depths.0, depths.1.saturating_add(1)) {
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
                    retained_edge_certainty(&mut predecessors_complete, false);
                }
            }
        }
        (children, complete)
    }

    fn is_ancestor(&self, key: &NodeKey, node: &S::Node) -> bool {
        match key {
            NodeKey::Runtime(_) => self
                .ancestors
                .iter()
                .any(|(ancestor_key, _)| ancestor_key == key),
            NodeKey::Unavailable => self
                .ancestors
                .iter()
                .any(|(_, ancestor)| self.source.same_element(ancestor, node)),
        }
    }

    fn record(
        &mut self,
        failure: UiaFailure,
        axis: EnumerationAxis,
        raw_depth: u8,
        child_index: usize,
    ) {
        self.stats.reads.health.cannot_complete += 1;
        if self.failures.len() >= MAX_REPORTED_FAILURES {
            self.suppressed_failures += 1;
            return;
        }
        self.failures
            .push(enumeration_error(failure, axis, raw_depth, child_index));
    }

    fn note_visit(&mut self, logical_depth: u8, raw_depth: u8) {
        self.stats.traversal.nodes_visited += 1;
        self.stats.traversal.max_logical_depth =
            self.stats.traversal.max_logical_depth.max(logical_depth);
        self.stats.traversal.max_raw_depth = self.stats.traversal.max_raw_depth.max(raw_depth);
    }

    fn note_deadline_exhausted(&mut self) {
        self.stats.reads.health.deadline_exhausted += 1;
        self.complete = false;
    }
}

/// Builds the structured error a failed enumeration surfaces.
///
/// Shape only: the failure's own HRESULT or sentinel, which axis faulted, how
/// deep the walk was, and how many siblings had been retired. No name, class
/// name, property value, window title, or provider description may enter here —
/// adapter error text is cloned into session trace segments and the trace HTML
/// export, so anything baked in is persisted.
fn enumeration_error(
    failure: UiaFailure,
    axis: EnumerationAxis,
    raw_depth: u8,
    child_index: usize,
) -> AdapterError {
    uia_failure_error(failure, "enumerate the children of an element").with_details(json!({
        "kind": "child_enumeration_failed",
        "axis": axis.as_str(),
        "raw_depth": raw_depth,
        "child_index": child_index,
    }))
}

/// Names how many further faults the cap dropped.
///
/// The cap keeps one pathological target from flooding a trace segment, but a
/// consumer that sees eight errors and no count would read a systemic failure
/// as a local one. The number travels; the dropped errors do not.
fn annotate_suppressed(error: &mut AdapterError, suppressed: u32) {
    if suppressed == 0 {
        return;
    }
    let mut details = error.details.take().unwrap_or_else(|| json!({}));
    if let Some(map) = details.as_object_mut() {
        map.insert("suppressed_failures".into(), json!(suppressed));
    }
    error.details = Some(details);
}

/// Records whether every native predecessor of this edge was retained.
fn retained_edge_certainty(prefix_certain: &mut bool, retained: bool) -> bool {
    let edge_certain = *prefix_certain;
    *prefix_certain &= retained;
    edge_certain
}
