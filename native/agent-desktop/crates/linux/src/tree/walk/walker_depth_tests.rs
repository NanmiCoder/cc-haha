use std::collections::HashMap;

use agent_desktop_core::{AdapterError, Deadline};

use super::walker::walk_levels;
use super::wrapper::classify;
use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON};
use crate::tree::{Expansion, ObservedRead, Walk, WalkLimits, WalkedNode};

type Edges = HashMap<u32, Vec<u32>>;

const FRAME: u32 = 23;

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

fn expansions(
    edges: &Edges,
    nodes: &impl Fn(u32) -> ObservedRead,
    level: &[u32],
) -> Vec<Expansion<ObservedRead, u32>> {
    level
        .iter()
        .map(|key| Expansion::read(nodes(*key), edges.get(key).cloned().unwrap_or_default()))
        .collect()
}

fn walk(
    edges: &Edges,
    nodes: impl Fn(u32) -> ObservedRead,
    limits: &WalkLimits,
) -> Walk<ObservedRead> {
    walk_levels(
        0,
        limits,
        deadline(),
        |level| Ok(expansions(edges, &nodes, level)),
        classify,
    )
    .expect("an in-memory walk cannot fail")
}

fn chain(length: u32) -> Edges {
    (0..length).map(|key| (key, vec![key + 1])).collect()
}

fn blank_wrappers(key: u32) -> ObservedRead {
    match key {
        0 => read_of(FRAME, "Window", &[]),
        13 => read_of(PUSH_BUTTON, "Save", &["click"]),
        _ => read_of(PANEL, "", &["showContextMenu"]),
    }
}

fn named_containers(key: u32) -> ObservedRead {
    match key {
        0 => read_of(FRAME, "Window", &[]),
        13 => read_of(PUSH_BUTTON, "Save", &["click"]),
        _ => read_of(PANEL, "Group", &[]),
    }
}

fn ids(node: &WalkedNode<ObservedRead>, out: &mut Vec<String>) {
    out.push(
        node.payload
            .node
            .properties
            .name
            .present()
            .cloned()
            .unwrap_or_default(),
    );
    node.children.iter().for_each(|child| ids(child, out));
}

fn names(walk: &Walk<ObservedRead>) -> Vec<String> {
    let mut found = Vec::new();
    ids(&walk.root, &mut found);
    found
}

fn depth_ten() -> WalkLimits {
    WalkLimits {
        max_logical_depth: 10,
        ..WalkLimits::default()
    }
}

#[test]
fn twelve_blank_wrappers_above_a_button_leave_it_inside_the_logical_depth() {
    let result = walk(&chain(13), blank_wrappers, &depth_ten());
    assert!(names(&result).contains(&"Save".to_owned()));
    assert!(result.complete);
    assert_eq!(result.counts.wrapper_nodes, 12);
    assert_eq!(result.counts.max_logical_depth, 1);
}

#[test]
fn twelve_named_containers_above_a_button_cut_it_at_the_logical_depth() {
    let result = walk(&chain(13), named_containers, &depth_ten());
    assert!(!names(&result).contains(&"Save".to_owned()));
    assert_eq!(result.counts.wrapper_nodes, 0);
    assert!(result.complete);
}

#[test]
fn a_node_at_the_logical_limit_keeps_its_child_count_and_stays_complete() {
    let result = walk(&chain(13), named_containers, &depth_ten());
    let mut cursor = &result.root;
    while let Some(next) = cursor.children.first() {
        cursor = next;
    }
    assert_eq!(cursor.child_count, Some(1));
    assert!(!cursor.truncated);
    assert_eq!(result.counts.limits.depth_hits, 0);
}

#[test]
fn every_container_cut_by_the_requested_depth_carries_its_count() {
    let edges: Edges = HashMap::from([
        (0, vec![1, 2]),
        (1, vec![3]),
        (2, vec![4]),
        (3, vec![5]),
        (4, vec![6]),
    ]);
    let shallow = WalkLimits {
        max_logical_depth: 2,
        ..WalkLimits::default()
    };
    let cut = walk(&edges, |_| read_of(PANEL, "n", &[]), &shallow);
    let deep = walk(&edges, |_| read_of(PANEL, "n", &[]), &depth_ten());
    assert_eq!(cut.node_count, 5);
    assert_eq!(deep.node_count, 7);
    let counts: Vec<Option<u32>> = cut
        .root
        .children
        .iter()
        .flat_map(|c| &c.children)
        .map(|n| n.child_count)
        .collect();
    assert_eq!(counts, [Some(1), Some(1)]);
    assert!(cut.complete);
}

#[test]
fn a_node_at_the_raw_limit_is_incomplete_and_counts_a_depth_hit() {
    let limits = WalkLimits {
        max_raw_depth: 2,
        max_logical_depth: 2,
        ..WalkLimits::default()
    };
    let result = walk(&chain(4), named_containers, &limits);
    let mut cursor = &result.root;
    while let Some(next) = cursor.children.first() {
        cursor = next;
    }
    assert!(cursor.truncated);
    assert_eq!(cursor.child_count, Some(1));
    assert!(!result.complete);
    assert_eq!(result.counts.limits.depth_hits, 1);
}

#[test]
fn a_child_list_over_the_cap_keeps_the_first_four_thousand_ninety_six() {
    let edges: Edges = HashMap::from([(0, (1..=4_200).collect())]);
    let result = walk(
        &edges,
        |_| read_of(PUSH_BUTTON, "b", &["click"]),
        &WalkLimits::default(),
    );
    assert_eq!(result.root.children.len(), 4_096);
    assert!(result.root.truncated);
    assert_eq!(result.root.child_count, Some(4_200));
    assert_eq!(result.counts.limits.child_hits, 1);
    assert!(!result.complete);
}

#[test]
fn an_exhausted_node_budget_marks_the_cut_parent_and_counts_a_hit() {
    let edges: Edges = HashMap::from([(0, vec![1, 2, 3, 4])]);
    let limits = WalkLimits {
        max_nodes: 3,
        ..WalkLimits::default()
    };
    let result = walk(&edges, |_| read_of(PUSH_BUTTON, "b", &["click"]), &limits);
    assert_eq!(result.node_count, 3);
    assert!(result.root.truncated);
    assert_eq!(result.root.child_count, Some(4));
    assert_eq!(result.counts.limits.node_hits, 1);
}

#[test]
fn an_exhausted_edge_budget_counts_a_hit() {
    let edges: Edges = HashMap::from([(0, vec![1, 2, 3, 4])]);
    let limits = WalkLimits {
        max_edges: 2,
        ..WalkLimits::default()
    };
    let result = walk(&edges, |_| read_of(PUSH_BUTTON, "b", &["click"]), &limits);
    assert_eq!(result.root.children.len(), 2);
    assert_eq!(result.counts.limits.edge_hits, 1);
}

#[test]
fn a_child_skipped_as_a_cycle_leaves_its_siblings_original_indices() {
    let edges: Edges = HashMap::from([(0, vec![1, 0, 2])]);
    let result = walk(
        &edges,
        |_| read_of(PUSH_BUTTON, "b", &["click"]),
        &WalkLimits::default(),
    );
    let indices: Vec<usize> = result
        .root
        .children
        .iter()
        .map(|c| c.source_index)
        .collect();
    assert_eq!(indices, [0, 2]);
    assert_eq!(result.counts.cycles_skipped, 1);
    assert!(result.complete);
}

#[test]
fn a_level_that_times_out_leaves_counted_parents_incomplete_and_the_walk_partial() {
    let edges: Edges = HashMap::from([(0, vec![1, 2]), (1, vec![3])]);
    let mut calls = 0;
    let result = walk_levels(
        0,
        &WalkLimits::default(),
        deadline(),
        |level| {
            calls += 1;
            if calls == 3 {
                return Err(AdapterError::timeout("slow level"));
            }
            Ok(expansions(
                &edges,
                &|_| read_of(PUSH_BUTTON, "b", &["click"]),
                level,
            ))
        },
        classify,
    )
    .expect("a timeout after the first levels keeps the partial walk");
    assert!(!result.complete);
    let cut = &result.root.children[0];
    assert!(cut.truncated);
    assert_eq!(cut.child_count, Some(1));
}

#[test]
fn a_parent_whose_child_read_failed_is_incomplete_and_carries_no_count() {
    let result = walk_levels(
        0,
        &WalkLimits::default(),
        deadline(),
        |level| {
            Ok(level
                .iter()
                .map(|key| Expansion {
                    payload: read_of(PUSH_BUTTON, "b", &["click"]),
                    children: if *key == 0 { vec![1] } else { Vec::new() },
                    children_unread: *key == 1,
                    gone: false,
                })
                .collect())
        },
        classify,
    )
    .expect("an unreadable child list does not abort the walk");
    assert!(!result.complete);
    let unread = &result.root.children[0];
    assert!(unread.truncated);
    assert_eq!(unread.child_count, None);
}

#[test]
fn a_web_document_marks_every_node_below_it() {
    let edges: Edges = HashMap::from([(0, vec![1]), (1, vec![2]), (2, vec![3])]);
    let nodes = |key: u32| match key {
        1 => read_of(95, "page", &[]),
        _ => read_of(PUSH_BUTTON, "b", &["click"]),
    };
    let result = walk(&edges, nodes, &WalkLimits::default());
    assert!(result.counts.met_web_document);
    let flags: Vec<bool> = std::iter::successors(Some(&result.root), |n| n.children.first())
        .map(|n| n.in_web_document)
        .collect();
    assert_eq!(flags, [false, false, true, true]);
}

#[test]
fn a_walk_rooted_below_a_web_document_marks_every_node_from_its_root() {
    let edges: Edges = HashMap::from([(0, vec![1])]);
    let nodes = |_: u32| read_of(PUSH_BUTTON, "b", &["click"]);
    let limits = WalkLimits {
        root_in_web: true,
        ..WalkLimits::default()
    };
    let result = walk(&edges, nodes, &limits);
    assert!(result.root.in_web_document);
    assert!(result.root.children[0].in_web_document);
    let outside = walk(&edges, nodes, &WalkLimits::default());
    assert!(!outside.root.in_web_document);
}
