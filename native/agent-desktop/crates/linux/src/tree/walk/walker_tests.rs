use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

use super::walker::walk_levels;
use super::walker_expand::{UNKNOWN_PID, child_elements, record_pids};
use crate::tree::{
    AtspiElement, ChildAddress, Expansion, Field, NodeClass, RawNode, Walk, WalkLimits, WalkedNode,
};

type Graph = HashMap<&'static str, Vec<&'static str>>;

fn walk(graph: &Graph, limits: &WalkLimits) -> Walk<&'static str> {
    let deadline = Deadline::after(5_000).expect("a five second deadline builds");
    walk_levels(
        "a",
        limits,
        deadline,
        |level| {
            Ok(level
                .iter()
                .map(|key| Expansion::read(*key, graph.get(key).cloned().unwrap_or_default()))
                .collect())
        },
        |_| NodeClass::default(),
    )
    .expect("an in-memory walk cannot fail")
}

fn names(node: &WalkedNode<&'static str>) -> Vec<&'static str> {
    let mut found = vec![node.payload];
    for child in &node.children {
        found.extend(names(child));
    }
    found
}

#[test]
fn a_child_that_points_back_to_an_ancestor_is_skipped_and_the_walk_completes() {
    let graph = Graph::from([("a", vec!["b"]), ("b", vec!["a", "c"])]);
    let result = walk(&graph, &WalkLimits::default());
    assert!(result.complete);
    assert_eq!(names(&result.root), ["a", "b", "c"]);
}

#[test]
fn a_node_reached_through_two_parents_is_visited_under_both() {
    let graph = Graph::from([("a", vec!["b", "c"]), ("b", vec!["d"]), ("c", vec!["d"])]);
    let result = walk(&graph, &WalkLimits::default());
    assert!(result.complete);
    assert_eq!(names(&result.root), ["a", "b", "d", "c", "d"]);
    assert_eq!(result.node_count, 5);
}

#[test]
fn a_node_budget_smaller_than_the_tree_marks_the_cut_nodes_and_the_result_incomplete() {
    let graph = Graph::from([("a", vec!["b", "c", "d"])]);
    let limits = WalkLimits {
        max_nodes: 3,
        ..WalkLimits::default()
    };
    let result = walk(&graph, &limits);
    assert!(!result.complete);
    assert!(result.root.truncated);
    assert_eq!(names(&result.root), ["a", "b", "c"]);
    assert!(result.root.children.iter().all(|child| !child.truncated));
}

fn locate<'a>(
    node: &'a WalkedNode<&'static str>,
    name: &str,
) -> Option<&'a WalkedNode<&'static str>> {
    if node.payload == name {
        return Some(node);
    }
    node.children.iter().find_map(|child| locate(child, name))
}

fn find<'a>(node: &'a WalkedNode<&'static str>, name: &str) -> &'a WalkedNode<&'static str> {
    locate(node, name).expect("the named node is in the tree")
}

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

#[test]
fn a_depth_limit_marks_the_node_it_stops_at_and_the_result_incomplete() {
    let graph = Graph::from([("a", vec!["b"]), ("b", vec!["c"])]);
    let limits = WalkLimits {
        max_raw_depth: 1,
        max_logical_depth: 1,
        ..WalkLimits::default()
    };
    let result = walk(&graph, &limits);
    assert!(!result.complete);
    assert_eq!(names(&result.root), ["a", "b"]);
    assert!(find(&result.root, "b").truncated);
    assert!(!result.root.truncated);
}

#[test]
fn a_timeout_after_the_first_level_returns_the_partial_tree_marked_incomplete() {
    let graph = Graph::from([("a", vec!["b", "c"]), ("b", vec!["d"]), ("c", vec!["e"])]);
    let mut calls = 0;
    let result = walk_levels(
        "a",
        &WalkLimits::default(),
        deadline(),
        |level| {
            calls += 1;
            if calls == 3 {
                return Err(AdapterError::timeout("level three timed out"));
            }
            Ok(level
                .iter()
                .map(|key| Expansion::read(*key, graph.get(key).cloned().unwrap_or_default()))
                .collect())
        },
        |_| NodeClass::default(),
    )
    .expect("a timeout after the first level keeps the tree read so far");
    assert!(!result.complete);
    assert_eq!(names(&result.root), ["a", "b", "c"]);
    assert!(find(&result.root, "b").truncated);
    assert!(find(&result.root, "c").truncated);
    assert!(!result.root.truncated);
}

#[test]
fn a_timeout_on_the_first_level_is_an_error() {
    let outcome = walk_levels::<&'static str, &'static str>(
        "a",
        &WalkLimits::default(),
        deadline(),
        |_| Err(AdapterError::timeout("the root timed out")),
        |_| NodeClass::default(),
    );
    assert_eq!(
        outcome.expect_err("no node was read").code,
        ErrorCode::Timeout
    );
}

#[test]
fn a_node_whose_children_could_not_be_read_is_truncated_and_the_walk_incomplete() {
    let result = walk_levels(
        "a",
        &WalkLimits::default(),
        deadline(),
        |level| {
            Ok(level
                .iter()
                .map(|key| match *key {
                    "a" => Expansion::read("a", vec!["b", "c"]),
                    "b" => Expansion {
                        payload: "b",
                        children: Vec::new(),
                        children_unread: true,
                        gone: false,
                    },
                    other => Expansion::read(other, Vec::new()),
                })
                .collect())
        },
        |_| NodeClass::default(),
    )
    .expect("an unreadable child list does not abort the walk");
    assert!(!result.complete);
    assert!(find(&result.root, "b").truncated);
    assert!(!find(&result.root, "c").truncated);
    assert_eq!(names(&result.root), ["a", "b", "c"]);
}

#[test]
fn a_child_that_vanished_is_kept_and_does_not_abort_the_walk() {
    let result = walk_levels(
        "a",
        &WalkLimits::default(),
        deadline(),
        |level| {
            Ok(level
                .iter()
                .map(|key| match *key {
                    "a" => Expansion::read("a", vec!["b", "c"]),
                    "b" => Expansion {
                        payload: "b",
                        children: Vec::new(),
                        children_unread: true,
                        gone: true,
                    },
                    other => Expansion::read(other, Vec::new()),
                })
                .collect())
        },
        |_| NodeClass::default(),
    )
    .expect("a vanished child does not abort the walk");
    assert!(!result.complete);
    assert_eq!(names(&result.root), ["a", "b", "c"]);
    assert!(result.root.truncated);
    assert!(find(&result.root, "b").truncated);
}

fn lookup(bus: &str, outcome: Result<u32, AdapterError>) -> (String, Result<u32, AdapterError>) {
    (bus.to_owned(), outcome)
}

#[test]
fn a_failed_process_lookup_leaves_the_bus_unrecorded_without_failing_the_level() {
    let mut pids = HashMap::new();
    let gone = AdapterError::new(ErrorCode::PlatformNotSupported, "name has no owner");
    record_pids(
        &mut pids,
        vec![lookup(":1.1", Ok(42)), lookup(":1.2", Err(gone))],
    )
    .expect("a vanished bus name is tolerated");
    assert_eq!(pids.get(":1.1"), Some(&42));
    assert!(!pids.contains_key(":1.2"));
}

#[test]
fn a_process_lookup_that_ran_out_of_budget_fails_the_level() {
    let mut pids = HashMap::new();
    let outcome = record_pids(
        &mut pids,
        vec![lookup(":1.1", Err(AdapterError::timeout("out of budget")))],
    );
    assert_eq!(
        outcome.expect_err("a timeout propagates").code,
        ErrorCode::Timeout
    );
}

#[test]
fn a_child_on_a_bus_with_no_known_process_is_still_listed() {
    let element = AtspiElement::new(":1.1", "/p", 7);
    let mut node = RawNode::unreadable(element, "x");
    let addresses: Vec<ChildAddress> = vec![
        (":1.1".to_owned(), "/a".to_owned()),
        (":1.2".to_owned(), "/b".to_owned()),
    ];
    node.children = Field::Present(addresses);
    let pids = HashMap::from([(":1.1".to_owned(), 7)]);
    let children = child_elements(&node, &pids);
    assert_eq!(children.len(), 2);
    assert_eq!(children[1].bus_name(), ":1.2");
    assert_eq!(children[1].pid(), UNKNOWN_PID);
}

#[test]
fn a_deadline_that_expired_before_the_first_level_is_a_timeout() {
    let deadline = Deadline::after(1).expect("a one millisecond deadline builds");
    std::thread::sleep(std::time::Duration::from_millis(20));
    let error = walk_levels(
        "a",
        &WalkLimits::default(),
        deadline,
        |_| Ok(vec![Expansion::read("a", Vec::new())]),
        |_| NodeClass::default(),
    )
    .expect_err("an expired deadline reads nothing");
    assert_eq!(error.code, ErrorCode::Timeout);
}
