use agent_desktop_core::{BoundsSpace, LocatorField, Rect};

use crate::tree::AtspiElement;

/// A live node that answers to the stored evidence, with its extents for the
/// geometry tie-break and its depth below the window frame (the frame is 0, so a
/// node's depth is the length of its child-index path).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) element: AtspiElement,
    pub(crate) bounds: LocatorField<Rect>,
    pub(crate) bounds_space: BoundsSpace,
    pub(crate) depth: usize,
    pub(crate) path: Vec<usize>,
}

impl Candidate {
    fn nested_with(&self, other: &Candidate) -> bool {
        let (short, long) = if self.path.len() <= other.path.len() {
            (&self.path, &other.path)
        } else {
            (&other.path, &self.path)
        };
        short != long && long.starts_with(short)
    }
}

/// Drops the candidates that sit in an ancestor or descendant relation with
/// the one the stored path names. A node and its own descendant that share an
/// identity (a list row and the label inside it) are one control read two
/// ways, not twins; siblings and nodes in separate subtrees stay candidates.
/// Without a candidate at the stored path nothing is dropped.
pub(crate) fn without_nested_relatives(candidates: &mut Vec<Candidate>, stored: &[usize]) {
    let Some(anchor) = candidates
        .iter()
        .position(|candidate| candidate.path == stored)
        .map(|index| candidates[index].clone())
    else {
        return;
    };
    candidates.retain(|candidate| candidate.path == stored || !candidate.nested_with(&anchor));
}
