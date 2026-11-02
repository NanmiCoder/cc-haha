use agent_desktop_core::{
    AccessibilityNode, LocatorEvidence, LocatorField, ObservationSource, ObservedSubtree,
    ObservedTree, WindowInfo, WindowState,
};

use super::Decorate;
use crate::tree::live::test_support::read_of;
use crate::tree::observe::projection::{project_node, project_with};
use crate::tree::vocabulary::role_numbers::{PANEL, PUSH_BUTTON};
use crate::tree::{ObservedRead, Walk, WalkCounts, WalkLimits, WalkedNode};

fn node(
    read: ObservedRead,
    source_index: usize,
    children: Vec<WalkedNode<ObservedRead>>,
) -> WalkedNode<ObservedRead> {
    WalkedNode {
        payload: read,
        children,
        truncated: false,
        child_count: None,
        source_index,
        in_web_document: false,
    }
}

fn walk() -> Walk<ObservedRead> {
    let first = node(read_of(PUSH_BUTTON, "First", &["click"]), 0, Vec::new());
    let second = node(read_of(PUSH_BUTTON, "Second", &["click"]), 3, Vec::new());
    Walk {
        root: node(read_of(PANEL, "Root", &[]), 0, vec![first, second]),
        complete: true,
        node_count: 3,
        max_depth: 1,
        counts: WalkCounts::default(),
    }
}

fn tree(subtree: ObservedSubtree, stats: agent_desktop_core::LocatorStats) -> AccessibilityNode {
    let window = WindowInfo {
        id: "w-1.1-p".to_owned(),
        title: "t".to_owned(),
        app: "a".to_owned(),
        pid: 1.into(),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };
    let root = agent_desktop_core::ObservationRoot::Window(&window);
    ObservedTree::from_roots(
        vec![subtree],
        ObservationSource::from_root(&root, agent_desktop_core::SnapshotSurface::Window),
        stats,
        true,
    )
    .expect("a projected walk builds a tree")
    .into_accessibility_tree_partial()
    .expect("one root projects")
    .0
}

fn extra(name: &str, index: usize) -> ObservedSubtree {
    let evidence = project_node(
        &read_of(PUSH_BUTTON, name, &[]),
        false,
        &WalkLimits::default(),
    );
    ObservedSubtree::new(evidence, Vec::new(), true, None).with_source_child_index(index)
}

#[derive(Default)]
struct Recording {
    prepared: usize,
    seen: Vec<(String, usize)>,
    finished_at: Option<usize>,
    finishes: usize,
}

impl Decorate for Recording {
    fn prepare(&mut self, root: &WalkedNode<ObservedRead>) {
        assert_eq!(root.children.len(), 2);
        self.prepared += 1;
    }

    fn decorate(
        &mut self,
        read: &ObservedRead,
        evidence: &mut LocatorEvidence,
        first_child_index: usize,
    ) -> Vec<ObservedSubtree> {
        let name = read
            .node
            .properties
            .name
            .present()
            .cloned()
            .unwrap_or_default();
        self.seen.push((name.clone(), first_child_index));
        if name == "First" {
            evidence.name = LocatorField::Known("Renamed".to_owned());
            return vec![extra("Child", first_child_index)];
        }
        Vec::new()
    }

    fn finish(&mut self, first_child_index: usize) -> Vec<ObservedSubtree> {
        self.finished_at = Some(first_child_index);
        self.finishes += 1;
        vec![extra("Tail", first_child_index)]
    }
}

#[test]
fn nodes_are_seen_in_document_order_with_the_index_their_children_end_at() {
    let mut hook = Recording::default();
    project_with(walk(), &WalkLimits::default(), &mut hook, None);
    assert_eq!(hook.prepared, 1);
    assert_eq!(
        hook.seen,
        [
            ("Root".to_owned(), 4),
            ("First".to_owned(), 0),
            ("Second".to_owned(), 0)
        ]
    );
}

#[test]
fn the_hook_changes_evidence_and_appends_children_after_the_node_own() {
    let mut hook = Recording::default();
    let (subtree, stats) = project_with(walk(), &WalkLimits::default(), &mut hook, None);
    let root = tree(subtree, stats);
    let names: Vec<_> = root
        .children
        .iter()
        .map(|c| c.identity.name.clone().unwrap_or_default())
        .collect();
    assert_eq!(names, ["Renamed", "Second", "Tail"]);
    assert_eq!(
        root.children[0].children[0].identity.name.as_deref(),
        Some("Child")
    );
}

#[test]
fn only_the_root_is_finished_and_it_ends_after_its_own_appended_children() {
    let mut hook = Recording::default();
    project_with(walk(), &WalkLimits::default(), &mut hook, None);
    assert_eq!(hook.finished_at, Some(4));
    assert_eq!(hook.finishes, 1);
}
