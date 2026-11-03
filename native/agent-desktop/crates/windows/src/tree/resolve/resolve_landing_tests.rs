//! The property every stored-path landing rests on.
//!
//! `read_children` only ever appends, and each of its exits breaks the loop
//! rather than skipping an entry, so a truncated enumeration is a *prefix* of
//! the real child list. `descend_path` applies that one level at a time, so the
//! pins below are stated at one level and compose down the path by the loop
//! that walks it.

use super::*;
use crate::tree::automation::UiaFailure;
use crate::tree::resolve::resolve_search::{SEARCH_DESCENT, walk_stored_path};
use crate::tree::walk::walker::TreeSource;
use agent_desktop_core::Deadline;

use super::tests::StubTree;

fn budget() -> WalkBudget {
    WalkBudget::new(10, Deadline::standard().expect("a standard deadline"))
}

/// The lemma the path tier trusts its landing on, and the reason a landing does
/// not have to wait on the rest of the walk: what a truncation removes is a
/// suffix, so every index below it still names the child a whole walk would
/// name there. A mid-list gap - the one shape that would make a landing a
/// guess - is unconstructible, because the enumeration has no way to skip an
/// entry and carry on.
///
/// A take stop is a truncation the walk chose: indices below it land on the
/// same child a whole walk names, and a fault past it is masked - the walk
/// never got there. A fault within take still surfaces beside the landing,
/// so this pin covers both halves: identical landings with no unread claimed
/// where nothing faulted, and the unread region surviving where it did.
#[test]
fn an_index_a_truncated_walk_reaches_names_the_child_a_whole_walk_names() {
    let short = StubTree::with_children(6).faulting_after(3);
    let whole = StubTree::with_children(6);

    for index in 0..2 {
        let landing = walk_stored_path(&short, &0, &[index], &budget())
            .expect("a transport fault never surfaces for the search");
        let control =
            walk_stored_path(&whole, &0, &[index], &budget()).expect("an unfaulting walk answers");

        assert_eq!(
            landing.element, control.element,
            "index {index} sits below the take stop, so the short walk must land on the same \
             child the whole walk lands on"
        );
        assert!(
            !landing.unread_region,
            "the short walk stopped before the fault it never reached, so it claims nothing \
             unread"
        );
    }

    let faulty = StubTree::with_children(6).faulting_after(1);
    let landing = walk_stored_path(&faulty, &0, &[2], &budget())
        .expect("a transport fault never surfaces for the search");

    assert_eq!(
        landing.element, None,
        "the fault inside take leaves index two unreached"
    );
    assert!(
        landing.unread_region,
        "a fault the walk did reach still withholds the verdict"
    );
}

/// The other half of the same property: the truncation is never crossed. An
/// index the read prefix does not reach lands nowhere rather than sliding onto
/// whatever sibling the enumeration did manage to read, so the fall-through to
/// the broad search - not a wrong element - is what a stored index past a gap
/// produces.
#[test]
fn an_index_past_a_truncation_lands_nowhere_rather_than_on_a_neighbour() {
    let truncated = StubTree::with_children(6).faulting_after(3);
    for index in 3..6 {
        let landing = walk_stored_path(&truncated, &0, &[index], &budget())
            .expect("a transport fault never surfaces for the search");
        assert_eq!(
            landing.element, None,
            "index {index} is past the truncation and must land nowhere"
        );
        assert!(landing.unread_region);
    }

    let control = walk_stored_path(&StubTree::with_children(6), &0, &[5], &budget())
        .expect("an unfaulting walk answers");
    assert_eq!(
        control.element,
        Some(6),
        "the same indices are reachable on a whole walk, so the pin above is not vacuous"
    );
}

/// A tier whose eligibility gate declined to run it read nothing, so it has no
/// region of its own to withhold a verdict for. Reporting one would make every
/// ref that skips the path tier - anything with an empty stored path - retry
/// against a gap that no attempt can ever close.
#[test]
fn a_path_tier_that_never_walked_lands_nowhere_and_claims_no_unread_region() {
    let landing = PathLanding::<usize>::not_walked();

    assert!(landing.element.is_none());
    assert!(
        !landing.unread_region,
        "a walk that never ran left nothing unread; the tiers below it still cover the tree"
    );
}

struct Counting<'a> {
    inner: &'a StubTree,
    calls: std::cell::Cell<usize>,
}

impl<'a> Counting<'a> {
    fn over(inner: &'a StubTree) -> Self {
        Self {
            inner,
            calls: std::cell::Cell::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.get()
    }
}

impl TreeSource for Counting<'_> {
    type Node = usize;

    fn first_child(&self, node: &usize) -> Result<usize, UiaFailure> {
        self.calls.set(self.calls.get() + 1);
        self.inner.first_child(node)
    }

    fn next_sibling(&self, node: &usize) -> Result<usize, UiaFailure> {
        self.calls.set(self.calls.get() + 1);
        self.inner.next_sibling(node)
    }

    fn identity(&self, node: &usize) -> crate::tree::walk::walker::NodeKey {
        self.inner.identity(node)
    }

    fn same_element(&self, left: &usize, right: &usize) -> bool {
        self.inner.same_element(left, right)
    }

    fn evidence(
        &self,
        node: &usize,
    ) -> (
        crate::tree::properties::ElementProperties,
        agent_desktop_core::LocatorEvidence,
        u64,
    ) {
        self.inner.evidence(node)
    }

    fn is_web_wrapper(
        &self,
        node: &usize,
        properties: &crate::tree::properties::ElementProperties,
    ) -> bool {
        self.inner.is_web_wrapper(node, properties)
    }
}

/// A path step needs the one child it names, never the siblings after it:
/// reaching index zero on a hundred-wide list costs one cross-process call,
/// where the whole-list walk costs a hundred and one.
#[test]
fn descend_path_reaches_index_zero_with_a_single_call() {
    let tree = StubTree::with_children(100);
    let counting = Counting::over(&tree);

    let landing = walk_stored_path(&counting, &0, &[0], &budget()).expect("a whole prefix answers");

    assert_eq!(landing.element, Some(1));
    assert_eq!(counting.calls(), 1);
}

/// The same bound mid-list: index fifty costs fifty-one calls, and the
/// landing is the child the whole walk names there.
#[test]
fn descend_path_costs_index_plus_one_calls_mid_list() {
    let tree = StubTree::with_children(100);
    let counting = Counting::over(&tree);

    let landing =
        walk_stored_path(&counting, &0, &[50], &budget()).expect("a whole prefix answers");

    assert_eq!(landing.element, Some(51));
    assert_eq!(counting.calls(), 51);
}

/// A take-hit keeps the truncated prefix and still reports it whole, like a
/// cap-hit: the broad search re-covers the unseen remainder on its own pass.
#[test]
fn take_reports_a_truncated_prefix_whole() {
    let tree = StubTree::with_children(100);

    let read = read_children(&tree, &0, &budget(), &SEARCH_DESCENT, Some(2))
        .expect("a bounded prefix answers");

    assert_eq!(read.elements.len(), 2);
    assert!(read.complete);
}

/// An index past the end still lands nowhere, take or no take: exhaustion is
/// a complete answer about a list that simply ends.
#[test]
fn a_miss_past_the_end_still_lands_nowhere() {
    let tree = StubTree::with_children(3);

    let landing = walk_stored_path(&tree, &0, &[5], &budget()).expect("exhaustion answers");

    assert!(landing.element.is_none());
    assert!(!landing.unread_region);
}
