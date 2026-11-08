use super::test_support::window;
use super::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorMaterialization, LocatorRefEvidence,
    LocatorResolveRequest, LocatorSelection, LocatorStats, ObservationRequest, ObservationRoot,
    ObservationSource, ObservedTree, resolve_query,
};
use crate::{
    AdapterError, ElementIdentifier, IdentifierKind, LocatorQuery, NativeHandle, Rect,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

const WRAPPER_COUNT: usize = 255;
const INITIAL_NODE_COUNT: u64 = WRAPPER_COUNT as u64 + 2;
const INITIAL_CHILD_READS: u64 = INITIAL_NODE_COUNT * 4;
const INITIAL_ATTRIBUTES_REQUESTED: u64 = INITIAL_NODE_COUNT * 6;

struct RoleOnlyHydrationAdapter {
    window_observations: AtomicUsize,
    strict_resolutions: AtomicUsize,
    hydration_observations: AtomicUsize,
}

impl ObservationOps for RoleOnlyHydrationAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match root {
            ObservationRoot::Window(_) => {
                self.window_observations.fetch_add(1, Ordering::SeqCst);
                crate::wait::deadline::sleep(Duration::from_millis(10));
                let evidence = request.descendant_evidence();
                assert!(!evidence.name);
                assert!(!evidence.description);
                assert!(!evidence.value);
                assert!(evidence.identifiers);
                assert!(evidence.ref_evidence.bounds);
                assert!(!evidence.states);
                assert!(!evidence.ref_evidence.actions);
                Ok(anchored_wrapper_tree())
            }
            ObservationRoot::Element { .. } => {
                self.hydration_observations.fetch_add(1, Ordering::SeqCst);
                assert_eq!(request.max_logical_depth, 0);
                assert_eq!(
                    request.evidence_for_raw_depth(0),
                    super::EvidenceRequirements::snapshot()
                );
                assert!(!request.evidence_for_raw_depth(1).name);
                assert!(!request.evidence_for_raw_depth(1).ref_evidence.actions);
                Ok(hydrated_button_tree(root))
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.strict_resolutions.fetch_add(1, Ordering::SeqCst);
        assert_eq!(entry.identity.name, None);
        assert_eq!(
            entry
                .identity
                .native_id
                .as_ref()
                .map(|id| id.value.as_str()),
            Some("primary-action")
        );
        assert_eq!(entry.geometry.bounds, Some(button_bounds()));
        assert_eq!(entry.scope.path.len(), WRAPPER_COUNT + 1);
        Ok(NativeHandle::null())
    }
}

impl ActionOps for RoleOnlyHydrationAdapter {}
impl InputOps for RoleOnlyHydrationAdapter {}
impl SystemOps for RoleOnlyHydrationAdapter {}

#[test]
fn role_only_selected_hydration_anchors_before_hydrating_without_rewalking_large_tree() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = RoleOnlyHydrationAdapter {
        window_observations: AtomicUsize::new(0),
        strict_resolutions: AtomicUsize::new(0),
        hydration_observations: AtomicUsize::new(0),
    };
    let query = LocatorQuery {
        identity: crate::IdentityPredicate {
            role: Some("button".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let request = LocatorResolveRequest {
        selection: LocatorSelection::First,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    };

    let resolution = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window()),
        &request,
    )
    .expect("role-only selected hydration should use the observed path");

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.strict_resolutions.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 1);
    assert_eq!(
        resolution.stats.traversal.nodes_visited,
        INITIAL_NODE_COUNT + 1
    );
    assert_eq!(
        resolution.stats.reads.counts.child_reads,
        INITIAL_CHILD_READS
    );
    assert_eq!(
        resolution.stats.reads.counts.attributes_requested,
        INITIAL_ATTRIBUTES_REQUESTED + 23
    );
    assert_eq!(resolution.stats.reads.counts.action_reads, 1);
    assert_eq!(resolution.stats.semantic_reads.child_label_reads, 0);
    assert_eq!(resolution.stats.reads.counts.observation_attempts, 2);

    let matched = &resolution.matches[0];
    assert_eq!(matched.data.name, "Primary action");
    assert_eq!(matched.data.ref_id.as_deref(), Some("@e1"));
    let entry = resolution.refmap.as_ref().unwrap().get("@e1").unwrap();
    assert_eq!(entry.identity.name.as_deref(), Some("Primary action"));
    assert_eq!(
        entry
            .identity
            .native_id
            .as_ref()
            .map(|id| id.value.as_str()),
        Some("primary-action")
    );
    assert_eq!(entry.geometry.bounds, Some(button_bounds()));
    assert_eq!(
        entry.capabilities.available_actions,
        [crate::actions::capability::CLICK]
    );
    assert_eq!(entry.scope.path.len(), WRAPPER_COUNT + 1);
}

fn anchored_wrapper_tree() -> ObservedTree {
    let last = WRAPPER_COUNT + 1;
    let mut nodes = Vec::with_capacity(last + 1);
    for index in 0..=last {
        let role = if index == 0 {
            "window"
        } else if index == last {
            "button"
        } else {
            "group"
        };
        let children = (index < last)
            .then_some(vec![u32::try_from(index + 1).unwrap()])
            .unwrap_or_default();
        let path = vec![0; index];
        let evidence = if index == last {
            selected_anchor_evidence()
        } else {
            role_only_evidence(role)
        };
        nodes.push(super::test_support::node(
            u32::try_from(index).unwrap(),
            evidence,
            children,
            &path,
        ));
    }
    let mut tree = super::test_support::tree(nodes, vec![0], true);
    tree.stats = initial_stats();
    tree
}

fn selected_anchor_evidence() -> LocatorEvidence {
    let mut evidence = role_only_evidence("button");
    evidence.identifiers = IdentifierEvidence::typed(
        [ElementIdentifier {
            kind: IdentifierKind::AxIdentifier,
            value: "primary-action".into(),
        }],
        Some(0),
        true,
    );
    evidence.ref_evidence.bounds = LocatorField::Known(button_bounds());
    evidence
}

fn role_only_evidence(role: &str) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.into()),
        name: LocatorField::Unknown,
        description: LocatorField::Unknown,
        value: LocatorField::Unknown,
        identifiers: IdentifierEvidence::unknown(),
        states: LocatorField::Unknown,
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Unknown,
            available_actions: LocatorField::Unknown,
            descriptors: Default::default(),
        },
    }
}

fn hydrated_button_tree(root: ObservationRoot<'_>) -> ObservedTree {
    let mut evidence = super::test_support::evidence("button", Some("Primary action"));
    evidence.identifiers = IdentifierEvidence::typed(
        [ElementIdentifier {
            kind: IdentifierKind::AxIdentifier,
            value: "primary-action".into(),
        }],
        Some(0),
        true,
    );
    evidence.ref_evidence.bounds = LocatorField::Known(button_bounds());
    evidence.ref_evidence.available_actions =
        LocatorField::Known(vec![crate::actions::capability::CLICK.into()]);
    let mut tree = super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    );
    tree.source = ObservationSource::from_root(&root, crate::SnapshotSurface::Window);
    tree.stats.traversal.nodes_visited = 1;
    tree.stats.reads.counts.attribute_batches = 1;
    tree.stats.reads.counts.attributes_requested = 23;
    tree.stats.reads.counts.action_reads = 1;
    tree
}

fn initial_stats() -> LocatorStats {
    let mut stats = LocatorStats::default();
    stats.traversal.nodes_visited = INITIAL_NODE_COUNT;
    stats.reads.counts.attribute_batches = INITIAL_NODE_COUNT;
    stats.reads.counts.attributes_requested = INITIAL_ATTRIBUTES_REQUESTED;
    stats.reads.counts.child_reads = INITIAL_CHILD_READS;
    stats
}

fn button_bounds() -> Rect {
    Rect {
        x: 10.0,
        y: 20.0,
        width: 100.0,
        height: 30.0,
    }
}
