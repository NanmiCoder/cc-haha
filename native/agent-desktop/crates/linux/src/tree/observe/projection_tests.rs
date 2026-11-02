use std::collections::HashMap;

use agent_desktop_core::refs::ref_alloc::is_ref_able;
use agent_desktop_core::{
    AccessibilityNode, Deadline, ErrorCode, LocatorField, LocatorStats, ObservationSource,
    ObservedTree, Rect, WindowInfo, WindowState,
};

use super::{Projector, project, project_node};
use crate::tree::capabilities::value_read::ValueRead;
use crate::tree::live::test_support::read_of;
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON, SLIDER};
use crate::tree::walk::walker::walk_levels;
use crate::tree::walk::wrapper::classify;
use crate::tree::{
    Expansion, Extents, Field, ObservedRead, Walk, WalkCounts, WalkLimits, WalkedNode,
};

const FRAME: u32 = 23;
const LABEL: u32 = 29;

fn deadline() -> Deadline {
    Deadline::after(5_000).expect("a five second deadline builds")
}

fn node_of(read: ObservedRead) -> WalkedNode<ObservedRead> {
    WalkedNode {
        payload: read,
        children: Vec::new(),
        truncated: false,
        child_count: None,
        source_index: 0,
        in_web_document: false,
    }
}

fn evidence_of(read: ObservedRead) -> agent_desktop_core::LocatorEvidence {
    let limits = WalkLimits::default();
    project_node(&read, false, &limits)
}

fn walk(
    edges: &HashMap<u32, Vec<u32>>,
    nodes: impl Fn(u32) -> ObservedRead,
    limits: &WalkLimits,
) -> Walk<ObservedRead> {
    walk_levels(
        0,
        limits,
        deadline(),
        |level| {
            Ok(level
                .iter()
                .map(|key| {
                    Expansion::read(nodes(*key), edges.get(key).cloned().unwrap_or_default())
                })
                .collect())
        },
        classify,
    )
    .expect("an in-memory walk cannot fail")
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1.1-p".to_owned(),
        title: "t".to_owned(),
        app: "a".to_owned(),
        pid: 1.into(),
        process_instance: Some("i".to_owned()),
        bounds: None,
        state: WindowState::default(),
    }
}

fn observed(walk: Walk<ObservedRead>, limits: &WalkLimits) -> ObservedTree {
    let complete = walk.complete;
    let (subtree, stats) = project(walk, limits);
    let window = window();
    let root = agent_desktop_core::ObservationRoot::Window(&window);
    ObservedTree::from_roots(
        vec![subtree],
        ObservationSource::from_root(&root, agent_desktop_core::SnapshotSurface::Window),
        stats,
        complete,
    )
    .expect("a projected walk builds a tree")
}

pub(super) fn tree_of(walk: Walk<ObservedRead>, limits: &WalkLimits) -> AccessibilityNode {
    observed(walk, limits)
        .into_accessibility_tree_partial()
        .expect("one root projects")
        .0
}

#[test]
fn a_walked_tree_projects_roles_names_values_and_capabilities_as_read() {
    let edges = HashMap::from([(0, vec![1, 2])]);
    let nodes = |key: u32| match key {
        0 => read_of(FRAME, "Window", &[]),
        1 => read_of(PUSH_BUTTON, "Save", &["click", "clipboard.copy"]),
        _ => {
            let mut slider = read_of(SLIDER, "Volume", &[]);
            slider.value = ValueRead {
                value: Field::Present("50".to_owned()),
                truncated: false,
            };
            slider
        }
    };
    let limits = WalkLimits::default();
    let tree = tree_of(walk(&edges, nodes, &limits), &limits);
    assert_eq!(tree.role, "window");
    let [button, slider] = tree.children.as_slice() else {
        panic!("two children expected")
    };
    assert_eq!(
        (button.role.as_str(), button.identity.name.as_deref()),
        ("button", Some("Save"))
    );
    assert_eq!(button.presentation.available_actions, ["Click"]);
    assert_eq!(slider.role, "slider");
    assert_eq!(slider.identity.value.as_deref(), Some("50"));
}

#[test]
fn a_failed_state_read_is_unknown_not_an_empty_list() {
    let mut read = read_of(PUSH_BUTTON, "Save", &["click"]);
    read.node.traits.states = Field::Failed("timed out".to_owned());
    assert_eq!(evidence_of(read).states, LocatorField::Unknown);
}

#[test]
fn a_failed_action_read_is_unknown_capabilities() {
    let mut read = read_of(PUSH_BUTTON, "Save", &[]);
    read.node.actions = Field::Failed("timed out".to_owned());
    assert_eq!(
        evidence_of(read).ref_evidence.available_actions,
        LocatorField::Unknown
    );
}

#[test]
fn zero_extents_are_known_bounds_rects_core_cannot_hold_are_absent_and_a_failed_read_is_unknown() {
    let rect = |width, height| {
        LocatorField::Known(Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        })
    };
    let mut zero = read_of(PUSH_BUTTON, "z", &["click"]);
    zero.node.extents = Field::Present(Extents {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
    });
    assert_eq!(evidence_of(zero).ref_evidence.bounds, rect(0.0, 0.0));
    let mut negative = read_of(PUSH_BUTTON, "n", &["click"]);
    negative.node.extents = Field::Present(Extents {
        x: 0,
        y: 0,
        width: -1,
        height: -1,
    });
    assert_eq!(
        evidence_of(negative).ref_evidence.bounds,
        LocatorField::Absent
    );
    let mut sentinel = read_of(PUSH_BUTTON, "s", &["click"]);
    sentinel.node.extents = Field::Present(Extents {
        x: i32::MIN,
        y: i32::MIN,
        width: i32::MIN,
        height: i32::MIN,
    });
    assert_eq!(
        evidence_of(sentinel).ref_evidence.bounds,
        LocatorField::Absent
    );
    let mut failed = read_of(PUSH_BUTTON, "f", &["click"]);
    failed.node.extents = Field::Failed("x".to_owned());
    assert_eq!(
        evidence_of(failed).ref_evidence.bounds,
        LocatorField::Unknown
    );
    let mut absent = read_of(PUSH_BUTTON, "a", &["click"]);
    absent.node.extents = Field::Absent;
    assert_eq!(
        evidence_of(absent).ref_evidence.bounds,
        LocatorField::Absent
    );
}

#[test]
fn a_value_is_known_absent_or_unknown_as_it_was_read() {
    let mut read = read_of(SLIDER, "s", &[]);
    assert_eq!(evidence_of(read.clone()).value, LocatorField::Absent);
    read.value.value = Field::Present("7".to_owned());
    assert_eq!(
        evidence_of(read.clone()).value,
        LocatorField::Known("7".to_owned())
    );
    read.value.value = Field::Failed("x".to_owned());
    assert_eq!(evidence_of(read).value, LocatorField::Unknown);
}

#[test]
fn a_name_over_the_field_budget_is_cut_and_counted() {
    let limits = WalkLimits {
        max_field_bytes: 8,
        ..WalkLimits::default()
    };
    let mut projector = Projector {
        limits: &limits,
        stats: LocatorStats::default(),
    };
    let read = read_of(PUSH_BUTTON, "a very long name", &["click"]);
    let evidence = projector.evidence_of(&read, false);
    assert_eq!(evidence.name, LocatorField::Known("a very l".to_owned()));
    assert_eq!(projector.stats.traversal.limits.text_hits, 1);
}

#[test]
fn a_container_cut_by_the_requested_depth_reports_its_count_and_stays_whole() {
    let edges = HashMap::from([(0, vec![1]), (1, vec![2])]);
    let nodes = |_: u32| read_of(PANEL, "named", &[]);
    let limits = WalkLimits {
        max_logical_depth: 1,
        ..WalkLimits::default()
    };
    let tree = tree_of(walk(&edges, nodes, &limits), &limits);
    let cut = &tree.children[0];
    assert_eq!(cut.children_count, Some(1));
    assert!(!cut.subtree_truncated);
    assert!(cut.children.is_empty());
}

#[test]
fn a_container_cut_by_the_raw_depth_reports_its_count_and_is_truncated() {
    let edges = HashMap::from([(0, vec![1]), (1, vec![2])]);
    let nodes = |_: u32| read_of(PANEL, "named", &[]);
    let limits = WalkLimits {
        max_raw_depth: 1,
        max_logical_depth: 1,
        ..WalkLimits::default()
    };
    let tree = tree_of(walk(&edges, nodes, &limits), &limits);
    let cut = &tree.children[0];
    assert_eq!(cut.children_count, Some(1));
    assert!(cut.subtree_truncated);
}

fn count_refable(node: &AccessibilityNode) -> usize {
    usize::from(is_ref_able(node)) + node.children.iter().map(count_refable).sum::<usize>()
}

#[test]
fn a_four_hundred_node_tree_behind_a_wrapper_chain_refs_exactly_its_addressable_nodes() {
    let mut edges: HashMap<u32, Vec<u32>> = (0..15).map(|key| (key, vec![key + 1])).collect();
    edges.insert(15, (16..400).collect());
    let nodes = |key: u32| match key {
        0 => read_of(FRAME, "Window", &[]),
        1..=15 => read_of(PANEL, "", &["showContextMenu"]),
        _ => match key % 4 {
            0 => read_of(PUSH_BUTTON, "b", &["click"]),
            1 => read_of(LABEL, "text", &["menu.popup"]),
            2 => read_of(PANEL, "", &["showContextMenu", "scrollTo"]),
            _ => read_of(PANEL, "x", &["press"]),
        },
    };
    let expected = (16..400).filter(|key| matches!(key % 4, 0 | 3)).count();
    let limits = WalkLimits {
        max_logical_depth: 3,
        ..WalkLimits::default()
    };
    let tree = tree_of(walk(&edges, nodes, &limits), &limits);
    assert_eq!(count_refable(&tree), expected);
}

#[test]
fn siblings_out_of_native_order_are_rejected_so_the_index_reaches_core() {
    let mut root = node_of(read_of(FRAME, "Window", &[]));
    for index in [3, 1] {
        let mut child = node_of(read_of(PUSH_BUTTON, "b", &["click"]));
        child.source_index = index;
        root.children.push(child);
    }
    let limits = WalkLimits::default();
    let walked = Walk {
        root,
        complete: true,
        node_count: 3,
        max_depth: 1,
        counts: WalkCounts::default(),
    };
    let (subtree, stats) = project(walked, &limits);
    let window = window();
    let root = agent_desktop_core::ObservationRoot::Window(&window);
    let error = ObservedTree::from_roots(
        vec![subtree],
        ObservationSource::from_root(&root, agent_desktop_core::SnapshotSurface::Window),
        stats,
        true,
    )
    .expect_err("children out of native order must not build");
    assert_eq!(error.code, ErrorCode::Internal);
}

#[test]
fn a_walk_that_was_cut_short_projects_incomplete_and_the_all_or_nothing_read_refuses_it() {
    let edges = HashMap::from([(0, vec![1, 2, 3, 4])]);
    let limits = WalkLimits {
        max_nodes: 3,
        ..WalkLimits::default()
    };
    let tree = observed(
        walk(&edges, |_| read_of(PUSH_BUTTON, "b", &["click"]), &limits),
        &limits,
    );
    assert!(!tree.is_complete());
    let refused = tree
        .clone()
        .into_accessibility_tree()
        .expect_err("incomplete");
    assert_eq!(refused.code, ErrorCode::Timeout);
    let (partial, complete, nodes) = tree
        .into_accessibility_tree_partial()
        .expect("partial reads");
    assert!(!complete);
    assert_eq!(nodes, 3);
    assert!(partial.subtree_truncated);
}

#[test]
fn the_walk_statistics_reach_the_observation() {
    let edges = HashMap::from([(0, vec![1]), (1, vec![2])]);
    let nodes = |key: u32| match key {
        1 => read_of(PANEL, "", &[]),
        _ => read_of(PUSH_BUTTON, "b", &["click"]),
    };
    let limits = WalkLimits::default();
    let walked = walk(&edges, nodes, &limits);
    let (_, stats) = project(walked, &limits);
    assert_eq!(stats.traversal.nodes_visited, 3);
    assert_eq!(stats.traversal.web_wrapper_nodes, 1);
    assert_eq!(stats.traversal.max_raw_depth, 2);
    assert_eq!(stats.traversal.max_logical_depth, 1);
    assert_eq!(stats.reads.counts.child_reads, 3);
    assert_eq!(stats.reads.health.native_read_failures, 0);
}

#[path = "projection_retained_tests.rs"]
mod retained_tests;
