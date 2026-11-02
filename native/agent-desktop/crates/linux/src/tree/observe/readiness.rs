use std::time::Duration;

use crate::tree::vocabulary::role_numbers::is_web_document;
use crate::tree::{ObservedRead, WalkedNode};

/// Gap between two corroborating reads of a filling tree.
pub(crate) const POLL: Duration = Duration::from_millis(200);
const EQUAL_READS: usize = 3;
const BUDGET_PERCENT: u32 = 70;

use super::readiness_step::Step;

/// Decides when a web tree has stopped growing. A tree is settled when three
/// consecutive reads count the same nodes and non-busy document evidence or
/// a requested depth cut establishes readiness; the wait spends at most a share
/// of the budget the observation started with.
#[derive(Debug, Clone)]
pub(crate) struct Readiness {
    budget: Duration,
    last: Option<usize>,
    equal: usize,
}

impl Readiness {
    /// `remaining` is what the request's deadline had left when the wait began.
    pub(crate) fn new(remaining: Duration) -> Self {
        Self {
            budget: remaining * BUDGET_PERCENT / 100,
            last: None,
            equal: 0,
        }
    }

    pub(crate) fn needs_payload(&self) -> bool {
        self.equal >= EQUAL_READS - 1
    }

    /// Takes a full walk's count, elapsed wait, and whether a web document or
    /// requested depth cut proves the tree is more than an unfilled shell.
    pub(crate) fn after_walk(&mut self, nodes: usize, waited: Duration, ready: bool) -> Step {
        self.equal = if !ready {
            0
        } else if self.last == Some(nodes) {
            self.equal + 1
        } else {
            1
        };
        self.last = Some(nodes);
        if self.equal >= EQUAL_READS && ready {
            Step::Settled
        } else if waited + POLL > self.budget {
            Step::GiveUp
        } else {
            Step::Wait(POLL)
        }
    }
}

/// Whether the requested logical depth cut any subtree of a complete walk.
/// An unfilled browser shell is read in full, so it never carries a cut.
pub(crate) fn has_depth_cut(root: &WalkedNode<ObservedRead>) -> bool {
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if node.child_count.is_some() {
            return true;
        }
        pending.extend(&node.children);
    }
    false
}

/// Whether the walked tree contains a web document, which marks a web
/// host regardless of how its process is named.
pub(crate) fn has_web_document(root: &WalkedNode<ObservedRead>) -> bool {
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        if is_web_document(node.payload.node.traits.role.present().copied()) {
            return true;
        }
        pending.extend(&node.children);
    }
    false
}

/// A full document or a requested depth cut is ready only when every visited
/// role answered and no document is busy or has an unread state set.
pub(crate) fn ready(root: &WalkedNode<ObservedRead>) -> bool {
    let mut pending = vec![root];
    while let Some(node) = pending.pop() {
        let Some(role) = node.payload.node.traits.role.present() else {
            return false;
        };
        if is_web_document(Some(*role)) {
            let Some(states) = node.payload.node.traits.states.present() else {
                return false;
            };
            if crate::tree::vocabulary::state_bits::StateBits::new(states)
                .has(crate::tree::vocabulary::state_bits::BUSY)
            {
                return false;
            }
        }
        pending.extend(&node.children);
    }
    has_web_document(root) || has_depth_cut(root)
}

#[cfg(test)]
#[path = "readiness_tests.rs"]
mod tests;
