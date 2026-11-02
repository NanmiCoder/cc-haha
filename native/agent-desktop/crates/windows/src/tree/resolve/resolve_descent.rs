//! The bounded sibling enumeration and child-index path descent that both
//! resolvers drive.
//!
//! The broad search and the locator anchor walk the same two cross-process
//! primitives - one `first_child` followed by a `next_sibling` chain - under
//! the same sibling cap and the same deadline. They differ in exactly two
//! decisions: what a failed enumeration step means, and what an expired
//! deadline means. Those two are the parameters; the loop is written once.
//!
//! The loop consults the deadline on every iteration, mirroring the element
//! walk's own enumeration (`walker_enumerate.rs`). Checking it only around the
//! enumeration would let a pathological list run the whole sibling cap - up to
//! `WalkBudget::max_siblings` cross-process calls - after the budget was
//! already spent.

use agent_desktop_core::AdapterError;

use crate::tree::automation::{UiaFailure, uia_failure_error};
use crate::tree::walk::walker::{TreeSource, WalkBudget};

/// What a failed enumeration step means to the resolver that asked for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DescentVerdict {
    /// The node enumerates nothing further and that is a real answer: keep
    /// what was collected, and the list still counts as whole.
    Settled,
    /// The node enumerates nothing further, but only because a read failed:
    /// keep what was collected and record that the list is partial.
    Unfinished,
    /// The failure is the attempt's answer and propagates as an error.
    Surfaced,
}

/// What an expired deadline means to the resolver that asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExpiryPolicy {
    /// Keep the partial list and record that it is partial. For a resolver
    /// whose partial answer is already retried, an unfinished enumeration is
    /// the signal it acts on.
    Unfinish,
    /// Surface the timeout. For a resolver that settles in a single attempt, a
    /// partial list would be read as a settled absence - "the element is gone" -
    /// when the truth is only that time ran out.
    Surface,
}

/// The two decisions that differ between the resolvers, with the shape-only
/// phrase each enumeration axis reports a surfaced failure under.
pub(crate) struct DescentPolicy {
    pub(crate) classify: fn(UiaFailure) -> DescentVerdict,
    pub(crate) on_expiry: ExpiryPolicy,
    pub(crate) descend_context: &'static str,
    pub(crate) sibling_context: &'static str,
}

/// One node's child list as the enumeration found it.
#[derive(Debug)]
pub(crate) struct ChildList<N> {
    pub(crate) elements: Vec<N>,
    pub(crate) complete: bool,
}

/// Where a child-index path walk ended, and what that walk left unread.
///
/// The two are separate facts about separate parts of the tree, returned
/// unfolded because folding them loses the only property that makes either one
/// usable.
///
/// `element` is trustworthy on its own terms. [`read_children`] only ever
/// appends, and every exit it can take - the sibling cap, an expired deadline,
/// a failed read - breaks the loop rather than skipping an entry, so the list
/// it returns is always a *prefix* of the node's real child list. An index that
/// prefix reaches therefore names the same child the whole list would name at
/// that index, and [`descend_path`] descends only through indices the prefix
/// reached: a stored index past a truncation reads `None` and lands nowhere. So
/// a landed element is the element the stored path names, and anything an
/// enumeration on the way down failed to read lies strictly *after* the index
/// this walk used at that level.
///
/// `unread_region` is a fact about that unread remainder and never about the
/// landing. It says this walk did not see the whole tree, so a verdict that
/// depends on having seen the whole of it - above all a negative one, "the
/// stored element is gone" - is not this walk's to settle.
pub(crate) struct PathLanding<N> {
    pub(crate) element: Option<N>,
    pub(crate) unread_region: bool,
}

impl<N> PathLanding<N> {
    /// The landing of a path walk that was never run, for a caller whose
    /// eligibility gate declined the tier. It read nothing, so it lands
    /// nowhere and leaves no region unread of its own - the tiers below it
    /// still cover the whole tree.
    pub(crate) fn not_walked() -> Self {
        Self {
            element: None,
            unread_region: false,
        }
    }
}

/// Enumerates one element's children, honouring the sibling cap as a hard
/// bound on pathological lists and the deadline as a bound on time.
///
/// `take` stops the loop after that many siblings: `None` enumerates the
/// whole list (the broad search, which must see every sibling to settle an
/// absence), while `descend_path` passes the wanted index plus one, so
/// reaching the wanted index costs index-plus-one cross-process calls
/// however long the list runs. A take-hit reports whole exactly like a
/// cap-hit, for the same reason: no verdict the caller draws from the
/// returned prefix changes - an index the prefix reaches names the same
/// child the whole list would name - and an unfinished verdict would
/// withhold the entire search's answer over siblings the broad search still
/// walks in full on its own pass. The one shape this does not cover is a
/// ref deeper than the search's own depth cap whose path declines: the
/// broad search cannot reach past its cap to re-cover a take-truncated
/// remainder down there, so that remainder is unseen by every tier.
///
/// The cap is the other place this enumeration's completeness is not
/// literal: a cap-hit keeps the truncated list and still reports it whole.
/// That is deliberate. The bound exists to make the loop total against a
/// sibling chain that never terminates - the ancestor cycle guard cannot see
/// such a chain, because it revisits no element on any root-to-node path -
/// not to clamp a large but finite list. Measured breadth is nowhere near
/// it: the widest node in the probe corpus sits in a virtualized Explorer
/// file list whose entire tree over `%WINDIR%\System32` is 196 nodes (A1-1),
/// and a WinForms `ListBox` exposes no items at all to a COM client (A17-2).
///
/// Reporting the truncation unfinished would cost more honesty than it buys,
/// for two reasons. The bound is shared with the walk that issues refs in the
/// first place: `walk_from_root` enumerates under the same
/// `WalkBudget::max_siblings` and refuses to present a cap-cut child list as
/// whole, so no stored ref can name an element past this point in its parent's
/// sibling list. And an unfinished verdict is not scoped to the node that
/// truncated - it withholds the entire search's answer, so one oversized list
/// anywhere in a window would convert a correct settled miss elsewhere in that
/// window into a retry loop that re-truncates identically on every attempt and
/// expires as `TIMEOUT`.
pub(crate) fn read_children<S: TreeSource>(
    source: &S,
    element: &S::Node,
    budget: &WalkBudget,
    policy: &DescentPolicy,
    take: Option<usize>,
) -> Result<ChildList<S::Node>, AdapterError> {
    let limit = take
        .map(|take| take.min(budget.max_siblings))
        .unwrap_or(budget.max_siblings);
    let mut elements = Vec::new();
    let mut current = match source.first_child(element) {
        Ok(first) => first,
        Err(failure) if failure.is_exhaustion() => {
            return Ok(ChildList {
                elements,
                complete: true,
            });
        }
        Err(failure) => return classified(failure, elements, policy, policy.descend_context),
    };
    loop {
        if elements.len() >= limit {
            break;
        }
        if let Err(expired) = budget.deadline.ensure_remaining() {
            return match policy.on_expiry {
                ExpiryPolicy::Unfinish => Ok(ChildList {
                    elements,
                    complete: false,
                }),
                ExpiryPolicy::Surface => Err(expired),
            };
        }
        elements.push(current.clone());
        if elements.len() >= limit {
            break;
        }
        match source.next_sibling(&current) {
            Ok(sibling) => current = sibling,
            Err(failure) if failure.is_exhaustion() => break,
            Err(failure) => return classified(failure, elements, policy, policy.sibling_context),
        }
    }
    Ok(ChildList {
        elements,
        complete: true,
    })
}

/// Walks the stored child-index path from a root, O(depth) child reads.
///
/// Each level enumerates only to the wanted index plus one and stops: a path
/// step needs the one child it names, never the thousand siblings after it
/// (a ref to a subkey near the top of an expanded registry hive would
/// otherwise read all of the hive's thousands of subkeys first). A path step that lands nowhere yields no element;
/// what that absence means belongs to the caller, not here. The index is
/// taken against the raw enumeration, the same space the walk that issued
/// the ref recorded its stored index in, so a walk that omitted a sibling
/// from its own output still leaves the stored index pointing at the child
/// it named.
pub(crate) fn descend_path<S: TreeSource>(
    source: &S,
    root: &S::Node,
    path: &[usize],
    budget: &WalkBudget,
    policy: &DescentPolicy,
) -> Result<PathLanding<S::Node>, AdapterError> {
    let mut current = root.clone();
    let mut unread_region = false;
    for &index in path {
        let read = read_children(
            source,
            &current,
            budget,
            policy,
            Some(index.saturating_add(1)),
        )?;
        unread_region |= !read.complete;
        let Some(child) = read.elements.get(index) else {
            return Ok(PathLanding {
                element: None,
                unread_region,
            });
        };
        current = child.clone();
    }
    Ok(PathLanding {
        element: Some(current),
        unread_region,
    })
}

fn classified<N>(
    failure: UiaFailure,
    elements: Vec<N>,
    policy: &DescentPolicy,
    context: &str,
) -> Result<ChildList<N>, AdapterError> {
    match (policy.classify)(failure) {
        DescentVerdict::Settled => Ok(ChildList {
            elements,
            complete: true,
        }),
        DescentVerdict::Unfinished => Ok(ChildList {
            elements,
            complete: false,
        }),
        DescentVerdict::Surfaced => Err(uia_failure_error(failure, context)),
    }
}

#[cfg(test)]
#[path = "resolve_descent_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resolve_landing_tests.rs"]
mod landing_tests;
