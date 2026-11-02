use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, LocatorEvidence, LocatorField, LocatorStats,
    ObservationRoot, ObservationSource, ObservedTree,
};
use serde_json::json;

use super::walker_enumerate::TreeWalk;
use crate::tree::automation::UiaFailure;
use crate::tree::properties::ElementProperties;
use crate::tree::properties::element_properties::ResolvedVocabulary;

/// The deepest native nesting one walk descends through.
///
/// Matches core's own ceiling on `ObservationRequest::max_raw_depth`, so a
/// request core accepts is never rejected here.
pub const DEFAULT_MAX_RAW_DEPTH: u8 = 50;

/// The longest sibling list one parent contributes.
///
/// The ancestor cycle guard cannot see a sibling chain that never terminates,
/// because such a chain visits no element twice on any root-to-node path. This
/// bound is what makes the enumeration loop total; hitting it marks the subtree
/// incomplete rather than presenting a short list as the whole child set.
pub const DEFAULT_MAX_SIBLINGS: usize = 10_000;

/// Everything that bounds one walk.
#[derive(Debug, Clone, Copy)]
pub struct WalkBudget {
    pub max_raw_depth: u8,
    pub max_logical_depth: u8,
    pub max_siblings: usize,
    pub deadline: Deadline,
}

impl WalkBudget {
    pub fn new(max_logical_depth: u8, deadline: Deadline) -> Self {
        Self {
            max_raw_depth: DEFAULT_MAX_RAW_DEPTH,
            max_logical_depth,
            max_siblings: DEFAULT_MAX_SIBLINGS,
            deadline,
        }
    }

    pub fn with_max_raw_depth(mut self, max_raw_depth: u8) -> Self {
        self.max_raw_depth = max_raw_depth;
        self
    }

    pub fn with_max_siblings(mut self, max_siblings: usize) -> Self {
        self.max_siblings = max_siblings;
        self
    }
}

/// What the cycle guard compares.
///
/// UI Automation hands back a *new* `IUIAutomationElement` proxy for every
/// query, so pointer identity says nothing at all — the macOS guard's key does
/// not transfer even though its ancestor-path semantics do. The runtime id is
/// the identity UI Automation itself publishes; when a provider will not supply
/// one, the guard falls back to asking the client to compare two elements.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKey {
    Runtime(Vec<i32>),
    Unavailable,
}

/// The single enumeration surface the walk drives.
///
/// The real UI Automation walker and the in-memory fakes implement this same
/// trait, so the correctness branches the fakes exercise are the branches that
/// ship. A fake wired to a second traversal would test nothing.
pub trait TreeSource {
    type Node: Clone;

    /// Descends one level. `Err` whose failure `is_exhaustion()` means the
    /// element has no children.
    fn first_child(&self, node: &Self::Node) -> Result<Self::Node, UiaFailure>;

    /// Advances along a sibling list. `Err` whose failure `is_exhaustion()`
    /// ends the list; anything else is a genuine fault.
    fn next_sibling(&self, node: &Self::Node) -> Result<Self::Node, UiaFailure>;

    fn identity(&self, node: &Self::Node) -> NodeKey;

    /// Compares two elements when neither carries a runtime id.
    fn same_element(&self, left: &Self::Node, right: &Self::Node) -> bool;

    /// Reads this node's evidence and the read set that built it, returning
    /// the count of reads that failed.
    ///
    /// The properties come back so the wrapper predicate can consume the same
    /// read set without a second fetch.
    fn evidence(
        &self,
        node: &Self::Node,
    ) -> (
        crate::tree::properties::ElementProperties,
        LocatorEvidence,
        u64,
    );

    /// Whether this element is a transparent wrapper that costs raw depth but
    /// no logical depth.
    ///
    /// The predicate consumes the properties this walk has already read
    /// (control type, name, value, `AutomationId`, actions), so the
    /// enumeration's per-node read set is not paid for twice.
    fn is_web_wrapper(
        &self,
        node: &Self::Node,
        properties: &crate::tree::properties::ElementProperties,
    ) -> bool;
}

/// One completed walk.
///
/// `failures` is populated when the tree is incomplete: a real enumeration
/// fault produces an incomplete tree *and* a structured error, never a
/// truncated success.
pub struct WalkOutcome {
    pub tree: ObservedTree,
    pub stats: LocatorStats,
    pub failures: Vec<AdapterError>,
}

/// Walks a subtree from an arbitrary root element.
///
/// The entry point is an element, not a window handle: `ElementFromHandle` is
/// one root source among several, and drill-down from a stored ref must re-enter
/// this same traversal rather than fork a second one.
///
/// No ref is allocated here. `agent_desktop_core::refs::ref_alloc::allocate_refs` is
/// the only allocator in the product.
pub fn walk_from_root<S: TreeSource>(
    source: &S,
    root: &S::Node,
    root_source: &ObservationRoot<'_>,
    budget: WalkBudget,
) -> Result<WalkOutcome, AdapterError> {
    let mut walk = TreeWalk::new(source, budget);
    let root_subtree = walk.visit(root.clone(), 0, 0);
    let (stats, structurally_complete, failures) = walk.finish()?;
    let root_subtree = root_subtree.ok_or_else(|| root_missing_error(&stats))?;
    let tree = ObservedTree::from_roots(
        vec![root_subtree],
        ObservationSource::from_root(root_source, root_source.surface()),
        stats.clone(),
        structurally_complete,
    )?;
    Ok(WalkOutcome {
        tree,
        stats,
        failures,
    })
}

fn root_missing_error(stats: &LocatorStats) -> AdapterError {
    let code = if stats.reads.health.deadline_exhausted > 0 {
        ErrorCode::Timeout
    } else {
        ErrorCode::AppUnresponsive
    };
    AdapterError::new(code, "Element tree walk ended before reading its root")
        .with_suggestion("Retry with a larger timeout or a narrower depth")
        .with_details(json!({
            "kind": "walk_root_unread",
            "deadline_exhausted": stats.reads.health.deadline_exhausted,
        }))
}

/// The role vocabulary, resolved from the properties the walk already read.
///
/// The seam takes the read set rather than the element because every input the
/// vocabulary needs - the control type and the pattern availability that
/// refines it - arrives in the same batch. Reading them again from the element
/// would cost a round trip per node for values already in hand.
pub fn walk_role(properties: &ElementProperties) -> LocatorField<String> {
    crate::tree::roles::resolve_role(properties)
}

/// The available-actions vocabulary, resolved from the same read set.
pub fn walk_available_actions(properties: &ElementProperties) -> LocatorField<Vec<String>> {
    crate::tree::actions::resolve_actions(properties)
}

/// The state vocabulary, which needs the resolved role: several UIA state
/// sources are only meaningful on some roles, and `ToggleState` in particular
/// means `checked` only on a toggleable role such as a checkbox or switch.
pub fn walk_states(
    properties: &ElementProperties,
    role: &LocatorField<String>,
) -> LocatorField<Vec<String>> {
    crate::tree::states::resolve_states(properties, role)
}

/// Resolves every interpreted slot from one element's read set.
///
/// One place, so the ordering dependency between them is visible: states needs
/// the role, and the name needs the label relation the caller resolved.
pub fn walk_vocabulary(
    properties: &ElementProperties,
    label: &crate::tree::name_evidence::LabelOutcome,
) -> ResolvedVocabulary {
    let role = walk_role(properties);
    let states = walk_states(properties, &role);
    let (name, description) = crate::tree::name_evidence::name_fields(properties, label);
    ResolvedVocabulary {
        role,
        available_actions: walk_available_actions(properties),
        states,
        name,
        description,
    }
}

#[cfg(test)]
#[path = "walker_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "walker_failure_tests.rs"]
mod failure_tests;
