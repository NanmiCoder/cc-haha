use crate::{
    AdapterError, WindowInfo,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, WindowFilter},
    locator::live_locator::{
        IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
        ObservationRequest, ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
    },
};

pub(crate) const FRAMED_LABEL: &str = "FramedLabel";

pub(crate) fn framed_label_screen_bounds() -> crate::Rect {
    crate::Rect {
        x: 214.0,
        y: 202.0,
        width: 177.0,
        height: 18.0,
    }
}

fn framed_label_window_bounds() -> crate::Rect {
    crate::Rect {
        x: 48.0,
        y: 70.0,
        width: 177.0,
        height: 18.0,
    }
}

pub(crate) struct LiveFindAdapter {
    structurally_complete: bool,
    framed_label: bool,
}

impl LiveFindAdapter {
    pub(crate) fn complete() -> Self {
        Self {
            structurally_complete: true,
            framed_label: false,
        }
    }

    pub(crate) fn incomplete() -> Self {
        Self {
            structurally_complete: false,
            framed_label: false,
        }
    }

    pub(crate) fn with_framed_label() -> Self {
        Self {
            structurally_complete: true,
            framed_label: true,
        }
    }

    fn evidence(role: &str, name: Option<&str>) -> LocatorEvidence {
        LocatorEvidence {
            role: LocatorField::Known(role.into()),
            name: name
                .map(|value| LocatorField::Known(value.into()))
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

    fn node(&self, evidence: LocatorEvidence, children: Vec<ObservedSubtree>) -> ObservedSubtree {
        ObservedSubtree::new(evidence, children, self.structurally_complete, None)
    }
}

impl ObservationOps for LiveFindAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if let ObservationRoot::Element { entry, .. } = &root {
            return ObservedTree::from_roots(
                vec![self.node(
                    Self::evidence(&entry.identity.role, entry.identity.name.as_deref()),
                    Vec::new(),
                )],
                ObservationSource::from_root(&root, request.surface),
                LocatorStats::default(),
                self.structurally_complete,
            );
        }
        let ObservationRoot::Window(window) = &root else {
            return Err(AdapterError::internal("expected locator root"));
        };
        let window = *window;
        let marker = if window.id == "w-2" {
            "OnlyInWindowTwo"
        } else {
            "OnlyInWindowOne"
        };
        let mut children = vec![self.node(Self::evidence("button", Some(marker)), Vec::new())];
        if self.framed_label {
            let mut label = Self::evidence("statictext", Some(FRAMED_LABEL));
            label.ref_evidence.bounds = LocatorField::Known(framed_label_screen_bounds());
            label.ref_evidence.window_bounds = LocatorField::Known(framed_label_window_bounds());
            children.push(self.node(label, Vec::new()));
        }
        let root_node = self.node(Self::evidence("window", Some(&window.title)), children);
        ObservedTree::from_roots(
            vec![root_node],
            ObservationSource::from_root(&root, request.surface),
            LocatorStats::default(),
            self.structurally_complete,
        )
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![
            WindowInfo {
                id: "w-1".into(),
                title: "First".into(),
                app: "FixtureApp".into(),
                pid: crate::ProcessId::new(101),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: true,
                    ..Default::default()
                },
            },
            WindowInfo {
                id: "w-2".into(),
                title: "Second".into(),
                app: "FixtureApp".into(),
                pid: crate::ProcessId::new(102),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: false,
                    ..Default::default()
                },
            },
        ])
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }
}

impl ActionOps for LiveFindAdapter {}

impl InputOps for LiveFindAdapter {}
impl SystemOps for LiveFindAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Window]
    }
}
