//! The path tier's second reading of a stored path, for the one drift a Win32
//! container causes on its own: growing scroll bars ahead of its content.
//!
//! A `SysTreeView32` or `SysListView32` whose content outgrows the view gains a
//! vertical scroll bar, a horizontal one and the size grip between them, and
//! the proxy exposes all three as the container's *first* children. Every
//! content child's raw index moves up by the chrome count, so a path recorded
//! before the growth now descends into a scroll bar. Regedit measured it: the
//! outline's children went from `[Computer]` to `[scrollbar, scrollbar,
//! handle, Computer]` the moment `HKEY_CLASSES_ROOT` expanded, and the broad
//! search the declined landing fell through to then read every one of the
//! expanded key's thousands of subkeys and spent the whole deadline.

use agent_desktop_core::RefEntry;

use super::resolve_search::{
    NodeAdmission, SEARCH_DESCENT, admit_node, can_use_path_fast_path, descent,
};
use crate::tree::walk::walker::{TreeSource, WalkBudget};

const LEADING_CHROME_ROLES: [&str; 2] = ["scrollbar", "handle"];

const MAX_LEADING_CHROME: usize = 3;

const SIBLING_CHECK_CAP: usize = 64;

/// Re-walks the stored path allowing for leading chrome that appeared after
/// the ref was recorded, and answers the landing only when a level shifted
/// and the landing is the one sibling that answers to the stored identity.
///
/// Leading chrome is the two scroll bars and the size grip (at most three
/// children, roles `scrollbar` and `handle`). A level that carries it is
/// shifted past it only when the stored index lands *inside* the chrome, the
/// one reading that cannot be ambiguous: a content ref recorded after the
/// chrome appeared counts it and never lands there. A level that carries
/// chrome but whose stored index lands on content cannot say whether it was
/// recorded before or after the chrome appeared, so the whole repair
/// declines rather than guess - either guess can enter a different container
/// whose child shares the stored identity, and a wrong verified target is
/// worse than leaving that ref to the broad search. Levels without chrome are
/// walked as stored. The identity check reads the landing's own siblings (a
/// list wider than 64 declines), and any read fault declines.
///
/// The stored bounds are deliberately not consulted. A container that grew
/// scroll bars also re-laid out and usually scrolled, so the stored rectangle
/// names a position that no longer exists.
pub(crate) fn repair_past_leading_chrome<S: TreeSource>(
    source: &S,
    root: &S::Node,
    entry: &RefEntry,
    budget: &WalkBudget,
) -> Option<S::Node> {
    if !can_use_path_fast_path(entry) {
        return None;
    }
    let mut parent = None;
    let mut current = root.clone();
    let mut shifted = false;
    for &index in entry.scope.path.iter() {
        let take = index.saturating_add(MAX_LEADING_CHROME + 1);
        let children =
            descent::read_children(source, &current, budget, &SEARCH_DESCENT, Some(take)).ok()?;
        let chrome = children
            .elements
            .iter()
            .take(MAX_LEADING_CHROME)
            .take_while(|child| is_leading_chrome(source, child))
            .count();
        if chrome > 0 && index >= chrome {
            return None;
        }
        shifted |= chrome > 0;
        let next = children.elements.get(index + chrome)?.clone();
        parent = Some(std::mem::replace(&mut current, next));
    }
    let parent = parent?;
    (shifted && is_unique_identity_match(source, &parent, &current, entry, budget))
        .then_some(current)
}

fn is_leading_chrome<S: TreeSource>(source: &S, node: &S::Node) -> bool {
    let (_, evidence, _) = source.evidence(node);
    evidence
        .role
        .known()
        .is_some_and(|role| LEADING_CHROME_ROLES.contains(&role.as_str()))
}

fn is_unique_identity_match<S: TreeSource>(
    source: &S,
    parent: &S::Node,
    landing: &S::Node,
    entry: &RefEntry,
    budget: &WalkBudget,
) -> bool {
    let Ok(siblings) = descent::read_children(
        source,
        parent,
        budget,
        &SEARCH_DESCENT,
        Some(SIBLING_CHECK_CAP + 1),
    ) else {
        return false;
    };
    if !siblings.complete || siblings.elements.len() > SIBLING_CHECK_CAP {
        return false;
    }
    let mut matched = None;
    for sibling in &siblings.elements {
        let (_, evidence, _) = source.evidence(sibling);
        match admit_node(entry, &evidence) {
            NodeAdmission::Collect if matched.is_none() => matched = Some(sibling),
            NodeAdmission::Collect | NodeAdmission::Unread => return false,
            NodeAdmission::Reject => {}
        }
    }
    matched.is_some_and(|only| source.same_element(only, landing))
}

#[cfg(test)]
#[path = "resolve_chrome_repair_tests.rs"]
mod tests;
