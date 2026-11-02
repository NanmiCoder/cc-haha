use super::*;
use crate::tree::automation::UiaFailure;
use crate::tree::walk::walker_enumerate::TreeWalk;
use crate::tree::walk::walker_fake::{
    E_FAIL, EXHAUSTION, FakeTree, REAL_FAILURE, budget, walk, walk_expecting_failure,
};
use agent_desktop_core::{Deadline, ErrorCode};

/// The fakes encode the measured pair, not a reading of the crate. If this
/// fails, every other fake-driven assertion below is testing the wrong model.
#[test]
fn the_fakes_are_built_from_the_measured_error_pair() {
    assert!(EXHAUSTION.is_exhaustion());
    assert!(!REAL_FAILURE.is_exhaustion());
    assert_eq!(REAL_FAILURE, UiaFailure::Hresult(E_FAIL));
}

/// A genuinely cyclic child graph: the deepest node's child is the root. Only
/// the guard ends this walk within the requested depth.
#[test]
fn a_repeated_identity_is_skipped_once_and_the_walk_terminates() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3])
        .with_children(3, &[1]);

    let outcome = walk(&fake, budget(10));

    assert_eq!(outcome.stats.traversal.cycles_skipped, 1);
    assert_eq!(outcome.stats.traversal.limits.depth_hits, 0);
    assert!(outcome.tree.is_complete());
}

/// The key is the identity the provider publishes, not the element the client
/// happens to hold: UI Automation returns a new proxy per query, so a distinct
/// proxy reporting an ancestor's runtime id is the same element.
#[test]
fn a_cycle_is_detected_by_published_identity_and_not_by_node_value() {
    let fake = FakeTree::default().with_chain(&[1, 2, 3, 4]).aliasing(4, 2);

    let outcome = walk(&fake, budget(10));

    assert_eq!(outcome.stats.traversal.cycles_skipped, 1);
}

#[test]
fn a_provider_without_a_runtime_id_is_guarded_by_element_comparison() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3, 4])
        .aliasing(4, 2)
        .unkeyed(2)
        .unkeyed(4);

    let outcome = walk(&fake, budget(10));

    assert_eq!(outcome.stats.traversal.cycles_skipped, 1);
}

/// A cycle on one branch must not prune an unrelated branch that reaches the
/// same element, which is what a global visited set would do.
#[test]
fn the_guard_is_an_ancestor_path_and_not_a_global_visited_set() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(2, &[4])
        .with_children(3, &[5])
        .aliasing(5, 4);

    let outcome = walk(&fake, budget(10));

    assert_eq!(outcome.stats.traversal.cycles_skipped, 0);
    assert!(outcome.tree.is_complete());
}

#[test]
fn benign_exhaustion_produces_a_complete_subtree() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(2, &[4]);

    let outcome = walk(&fake, budget(10));

    assert!(outcome.tree.is_complete());
    assert!(outcome.failures.is_empty());
}

#[test]
fn a_real_descent_failure_produces_an_incomplete_tree_and_a_structured_error() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3])
        .with_children(2, &[4])
        .faulting_on_first_child(4);

    let outcome = walk(&fake, budget(10));

    assert!(!outcome.tree.is_complete());
    assert!(!outcome.failures.is_empty());
    assert!(outcome.tree.into_accessibility_tree().is_err());
}

/// The siblings read before the fault are retired into the tree rather than
/// discarded with it, and `child_index` is the count that says how many.
/// Asserting only that the walk went incomplete would accept a loop that threw
/// the whole partial list away.
#[test]
fn a_real_sibling_failure_retires_the_prefix_and_still_reports_incomplete() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .faulting_on_next_sibling(3);

    let outcome = walk(&fake, budget(10));

    assert!(!outcome.tree.is_complete());
    let failure = outcome.failures.first().expect("a structured failure");
    let details = failure.details.as_ref().expect("structured details");
    assert_eq!(
        details["axis"], "next_sibling",
        "a sibling-walk failure must be reported as the sibling axis, not the first-child one"
    );
    assert_eq!(
        details["child_index"], 2,
        "the two siblings read before the fault are retired, not dropped with it"
    );
}

/// The child count this boundary also emits is asserted on the logical
/// boundary below instead: core exposes `children_count` only through
/// `into_accessibility_tree()`, which by contract refuses the incomplete tree
/// raw-depth truncation must produce.
#[test]
fn raw_depth_exhaustion_marks_incomplete_and_core_refuses_the_projection() {
    let fake = FakeTree::default().with_chain(&[1, 2, 3, 4]);

    let outcome = walk(&fake, budget(50).with_max_raw_depth(1));

    assert!(!outcome.tree.is_complete());
    assert!(outcome.stats.traversal.limits.depth_hits > 0);
    assert!(outcome.tree.into_accessibility_tree().is_err());
}

/// A depth boundary emits a child count in place of the children it did not
/// descend into, which is what makes the boundary a drill-down target rather
/// than a silent leaf.
#[test]
fn a_depth_boundary_reports_a_child_count_instead_of_children() {
    let fake = FakeTree::default().with_chain(&[1, 2, 3]);

    let outcome = walk(&fake, budget(1));
    let root = outcome
        .tree
        .into_accessibility_tree()
        .expect("core accepts a complete observation");
    let boundary = root.children.first().expect("the root retained its child");

    assert!(boundary.children.is_empty());
    assert!(boundary.children_count.is_some());
}

/// The boundary count read is time-boxed independently of the walk's own
/// deadline; under a generous deadline it still returns a real count.
#[test]
fn a_boundary_count_read_within_its_own_budget_reports_a_count() {
    let fake = FakeTree::default().with_chain(&[1, 2, 3]);

    let outcome = walk(&fake, budget(1));
    let root = outcome
        .tree
        .into_accessibility_tree()
        .expect("a read that finishes within its budget stays complete");
    let boundary = root.children.first().expect("the root retained its child");

    assert_eq!(boundary.children_count, Some(1));
}

/// A boundary count read that outlives its own 25ms budget yields no count,
/// while the boundary is still reported truncated - the two signals never
/// contradict each other even when the read itself was starved.
#[test]
fn a_starved_boundary_count_read_drops_the_count_but_keeps_truncation() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3])
        .slow_first_child(2, std::time::Duration::from_millis(40));

    let outcome = walk(&fake, budget(1));
    let (tree, complete, _) = outcome
        .tree
        .into_accessibility_tree_partial()
        .expect("a partial projection is available even when incomplete");
    let boundary = tree.children.first().expect("the root retained its child");

    assert!(
        !complete,
        "a starved boundary read must not report the walk complete"
    );
    assert!(boundary.children_count.is_none());
    assert!(boundary.subtree_truncated);
}

/// Without the `is_web_wrapper` seam the two counters can never disagree, so
/// this assertion would be testing behaviour this crate ships no mechanism
/// to produce. The control below is what makes that claim checkable.
#[test]
fn logical_and_raw_depth_diverge_when_a_node_is_a_web_wrapper() {
    let wrapped = FakeTree::default().with_chain(&[1, 2, 3]).wrapping(2);

    let outcome = walk(&wrapped, budget(10));

    assert!(outcome.stats.traversal.max_logical_depth < outcome.stats.traversal.max_raw_depth);
    assert_eq!(outcome.stats.traversal.web_wrapper_nodes, 1);
}

#[test]
fn logical_and_raw_depth_agree_when_no_node_is_a_web_wrapper() {
    let plain = FakeTree::default().with_chain(&[1, 2, 3]);

    let outcome = walk(&plain, budget(10));

    assert_eq!(
        outcome.stats.traversal.max_logical_depth,
        outcome.stats.traversal.max_raw_depth
    );
    assert_eq!(outcome.stats.traversal.web_wrapper_nodes, 0);
}

/// The removal this asserts is the one a walk most easily ships without: the
/// exit taken when enumeration faults part-way down a subtree.
#[test]
fn the_cycle_guard_is_unwound_on_the_error_exit_path() {
    let fake = FakeTree::default()
        .with_chain(&[1, 2, 3])
        .faulting_on_first_child(3);
    let mut walk = TreeWalk::new(&fake, budget(10));

    let subtree = walk.visit(1, 0, 0);

    assert!(subtree.is_some());
    assert_eq!(walk.ancestor_depth(), 0);
    let (_, complete, failures) = walk.finish().expect("the guard left nothing behind");
    assert!(!complete, "a faulting walk must not report complete");
    assert!(!failures.is_empty());
}

#[test]
fn the_cycle_guard_is_unwound_when_the_deadline_expires() {
    let fake = FakeTree::default().with_chain(&[1, 2, 3]);
    let expired = WalkBudget::new(10, Deadline::after(1).expect("a one millisecond deadline"));
    std::thread::sleep(std::time::Duration::from_millis(20));
    let mut walk = TreeWalk::new(&fake, expired);

    let subtree = walk.visit(1, 0, 0);

    assert!(subtree.is_none());
    assert_eq!(walk.ancestor_depth(), 0);
    let (stats, complete, _) = walk.finish().expect("the guard left nothing behind");
    assert!(
        !complete,
        "a walk cut short by its deadline must report incomplete, not merely unwind"
    );
    assert!(stats.reads.health.deadline_exhausted > 0);
}

/// A sibling list that never terminates is invisible to the ancestor guard, so
/// the sibling bound is what makes the enumeration loop total.
#[test]
fn an_endless_sibling_list_terminates_and_reports_incomplete() {
    let fake = FakeTree::default()
        .with_children(1, &[2])
        .looping_siblings(2);

    let outcome = walk(&fake, budget(10).with_max_siblings(4));

    assert!(!outcome.tree.is_complete());
    assert!(outcome.stats.traversal.limits.child_hits > 0);
}

#[test]
fn the_complete_case_projects_and_the_incomplete_case_is_refused() {
    let complete = FakeTree::default().with_children(1, &[2, 3]);
    let incomplete = FakeTree::default()
        .with_children(1, &[2, 3])
        .faulting_on_first_child(2);

    assert!(
        walk(&complete, budget(10))
            .tree
            .into_accessibility_tree()
            .is_ok()
    );
    assert!(
        walk(&incomplete, budget(10))
            .tree
            .into_accessibility_tree()
            .is_err()
    );
}

/// A walk whose root never yielded a subtree has to say *why*. The two causes
/// are not interchangeable: an expired budget is the caller's own limit and is
/// retryable with a larger one, while a root that simply produced nothing is
/// the target failing to answer.
#[test]
fn a_root_that_never_read_reports_the_cause_that_produced_it() {
    let fake = FakeTree::default().with_chain(&[1, 2]);
    let expired = WalkBudget::new(10, Deadline::after(1).expect("a one millisecond deadline"));
    std::thread::sleep(std::time::Duration::from_millis(20));

    let error = walk_expecting_failure(&fake, expired);

    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("kind"))
            .and_then(serde_json::Value::as_str),
        Some("walk_root_unread")
    );
}

/// `predecessors_complete` is what tells a consumer whether the child it is
/// looking at is preceded by every sibling the provider actually had. A child
/// after a dropped one must not claim an intact prefix.
#[test]
fn an_edge_after_a_dropped_sibling_reports_its_prefix_as_incomplete() {
    let fake = FakeTree::default()
        .with_children(1, &[2, 3, 4])
        .aliasing(2, 1);

    let outcome = walk(&fake, budget(10));
    let root = outcome
        .tree
        .into_accessibility_tree()
        .expect("core accepts the observation");

    assert_eq!(
        root.children.len(),
        2,
        "the cycle child is dropped and its siblings retained"
    );
}
