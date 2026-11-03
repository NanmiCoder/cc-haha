use super::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
    ObservationSource, ObservedNode, ObservedTree,
};
use crate::{WindowInfo, refs::RefPath};

pub(super) fn window() -> WindowInfo {
    WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "FixtureApp".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState {
            is_focused: true,
            ..Default::default()
        },
    }
}

pub(crate) fn evidence(role: &str, name: Option<&str>) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(role.to_string()),
        name: name
            .map(|value| LocatorField::Known(value.to_string()))
            .unwrap_or(LocatorField::Absent),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Known(Vec::new()),
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(Vec::new()),
            descriptors: Default::default(),
        },
    }
}

pub(crate) fn node(
    document_order: u32,
    evidence: LocatorEvidence,
    children: Vec<u32>,
    path: &[usize],
) -> ObservedNode {
    ObservedNode {
        evidence,
        path: RefPath::from_slice(path),
        children,
        document_order,
        completeness: super::ObservationCompleteness::new(true),
        children_count: None,
        ref_id: None,
    }
}

pub(crate) fn tree(
    nodes: Vec<ObservedNode>,
    roots: Vec<u32>,
    structurally_complete: bool,
) -> ObservedTree {
    for (index, node) in nodes.iter().enumerate() {
        assert_eq!(node.document_order as usize, index);
        assert!(node.children.iter().all(|child| *child as usize > index));
    }
    ObservedTree {
        nodes,
        roots,
        source: ObservationSource::Window {
            window: window(),
            surface: crate::SnapshotSurface::Window,
        },
        stats: LocatorStats::default(),
        structurally_complete,
    }
}
