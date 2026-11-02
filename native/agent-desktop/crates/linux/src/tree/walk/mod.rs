pub(super) mod admission;
pub(super) mod admit;
pub(super) mod expansion;
pub(super) mod level;
pub(super) mod node_class;
pub(super) mod walk_counts;
pub(super) mod walk_limits;
pub(super) mod walked_node;
pub(super) mod walker;
#[cfg(test)]
pub(super) mod walker_depth_tests;
pub(super) mod walker_expand;
#[cfg(test)]
pub(super) mod walker_tests;
pub(super) mod wrapper;

use super::{WalkCounts, WalkedNode};

/// A finished walk. `complete` is false when any subtree was cut short.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Walk<P> {
    pub(crate) root: WalkedNode<P>,
    pub(crate) complete: bool,
    pub(crate) node_count: usize,
    pub(crate) max_depth: usize,
    pub(crate) counts: WalkCounts,
}
