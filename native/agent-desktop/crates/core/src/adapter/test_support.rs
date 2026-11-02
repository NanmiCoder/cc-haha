pub(crate) struct NoopAdapter;

impl super::ObservationOps for NoopAdapter {}
impl super::ActionOps for NoopAdapter {}
impl super::InputOps for NoopAdapter {}
impl super::SystemOps for NoopAdapter {}

macro_rules! complete_live_observation {
    ($role:expr, $name:expr, [$($action:expr),* $(,)?]) => {
        $crate::adapter::complete_live_observation!(
            @impl $role,
            $name,
            [$($action),*],
            _adapter => $crate::ElementState {
                role: $role.into(),
                states: Vec::new(),
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            }
        );
    };
    ($role:expr, $name:expr, [$($action:expr),* $(,)?], $adapter:ident => $state:expr) => {
        $crate::adapter::complete_live_observation!(
            @impl $role,
            $name,
            [$($action),*],
            $adapter => $state
        );
    };
    (@impl $role:expr, $name:expr, [$($action:expr),* $(,)?], $adapter:ident => $state:expr) => {
        fn get_live_element(
            &self,
            _handle: &$crate::adapter::NativeHandle,
            _deadline: $crate::Deadline,
        ) -> Result<$crate::LiveElement, $crate::AdapterError> {
            let $adapter = self;
            Ok($crate::LiveElement {
                identity: $crate::LiveIdentity {
                    name: $crate::LocatorField::Known($name.into()),
                    description: $crate::LocatorField::Absent,
                    identifiers: $crate::IdentifierEvidence::absent(),
                },
                state: $state,
                states_complete: true,
                bounds: Some($crate::Rect {
                    x: 1.0,
                    y: 1.0,
                    width: 20.0,
                    height: 20.0,
                }),
                available_actions: vec![$($action.into()),*],
            })
        }

        fn get_live_state(
            &self,
            _handle: &$crate::adapter::NativeHandle,
            _deadline: $crate::Deadline,
        ) -> Result<Option<$crate::ElementState>, $crate::AdapterError> {
            let $adapter = self;
            Ok(Some($state))
        }

        fn get_element_bounds(
            &self,
            _handle: &$crate::adapter::NativeHandle,
            _deadline: $crate::Deadline,
        ) -> Result<Option<$crate::Rect>, $crate::AdapterError> {
            Ok(Some($crate::Rect {
                x: 1.0,
                y: 1.0,
                width: 20.0,
                height: 20.0,
            }))
        }

        fn get_live_actions(
            &self,
            _handle: &$crate::adapter::NativeHandle,
            _deadline: $crate::Deadline,
        ) -> Result<Option<Vec<String>>, $crate::AdapterError> {
            Ok(Some(vec![$($action.into()),*]))
        }

        fn hit_test(
            &self,
            _handle: &$crate::adapter::NativeHandle,
            _point: $crate::Point,
            _deadline: $crate::Deadline,
        ) -> Result<$crate::adapter::hit_test::HitTestResult, $crate::AdapterError> {
            Ok($crate::adapter::hit_test::HitTestResult::ReachesTarget)
        }
    };
}

pub(crate) use complete_live_observation;

macro_rules! guarded_interaction_lease {
    () => {
        fn acquire_interaction_lease(
            &self,
            deadline: $crate::Deadline,
        ) -> Result<$crate::InteractionLease, $crate::AdapterError> {
            $crate::InteractionLease::guarded(deadline, ())
        }
    };
}

pub(crate) use guarded_interaction_lease;

macro_rules! exact_window_focus {
    () => {
        fn resolve_window_strict(
            &self,
            window: &$crate::WindowInfo,
            _deadline: $crate::Deadline,
        ) -> Result<$crate::WindowInfo, $crate::AdapterError> {
            Ok(window.clone())
        }

        fn focus_window(
            &self,
            _window: &$crate::WindowInfo,
            _lease: &$crate::InteractionLease,
        ) -> Result<(), $crate::AdapterError> {
            Ok(())
        }
    };
}

pub(crate) use exact_window_focus;

/// The emptiest possible [`crate::RefEntry`]: no bounds, no capabilities, no
/// source window, no scope path. Callers that need more build on it with
/// struct-update syntax or direct field mutation rather than re-listing every
/// field.
pub(crate) fn minimal_ref_entry(role: &str, name: Option<&str>) -> crate::RefEntry {
    crate::RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: role.into(),
            name: name.map(String::from),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: None,
            bounds_hash: None,
        },
        capabilities: crate::RefCapabilities {
            states: Vec::new(),
            available_actions: Vec::new(),
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: crate::refs::RefPath::default(),
        },
    }
}

/// An [`crate::AccessibilityNode`] with no ref, no bounds, no children, and
/// no truncation - only a role and a name. Callers that need more mutate the
/// 1-2 fields they need on the returned value.
pub(crate) fn minimal_accessibility_node(role: &str, name: &str) -> crate::AccessibilityNode {
    crate::AccessibilityNode {
        ref_id: None,
        role: role.into(),
        identity: crate::NodeIdentity {
            name: Some(name.into()),
            ..Default::default()
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

pub(crate) fn live_identity(name: &str) -> crate::LiveIdentity {
    crate::LiveIdentity {
        name: crate::LocatorField::Known(name.into()),
        description: crate::LocatorField::Absent,
        identifiers: crate::IdentifierEvidence::absent(),
    }
}

pub(crate) fn recorded_action_state(requests: &[crate::ActionRequest]) -> crate::ElementState {
    let mut value = String::new();
    let mut checked = false;
    let mut expanded = false;
    for request in requests {
        match &request.action {
            crate::Action::Clear => value.clear(),
            crate::Action::SetValue(next) | crate::Action::TypeText(next) => value.clone_from(next),
            crate::Action::Check => checked = true,
            crate::Action::Uncheck => checked = false,
            crate::Action::Toggle => checked = !checked,
            crate::Action::Expand => expanded = true,
            crate::Action::Collapse => expanded = false,
            _ => {}
        }
    }
    let mut states = Vec::new();
    if checked {
        states.push(crate::tree::state::CHECKED.into());
    }
    if expanded {
        states.push(crate::tree::state::EXPANDED.into());
    }
    crate::ElementState {
        role: "textfield".into(),
        states,
        value: Some(value),
        enabled: Some(true),
        hidden: Some(false),
        offscreen: Some(false),
    }
}

pub(crate) fn observed_tree(
    root: &crate::locator::live_locator::ObservationRoot<'_>,
    node: crate::AccessibilityNode,
) -> Result<crate::locator::live_locator::ObservedTree, crate::AdapterError> {
    use crate::locator::live_locator::{
        IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
        ObservationSource, ObservedSubtree, ObservedTree,
    };

    fn field(value: Option<String>) -> LocatorField<String> {
        value
            .map(LocatorField::Known)
            .unwrap_or(LocatorField::Absent)
    }

    fn subtree(node: crate::AccessibilityNode) -> ObservedSubtree {
        let native_id = node.identity.native_id.clone();
        let evidence = LocatorEvidence {
            role: LocatorField::Known(node.role),
            name: field(node.identity.name),
            description: field(node.identity.description),
            value: field(node.identity.value),
            identifiers: IdentifierEvidence::typed(native_id, Some(0), true),
            states: LocatorField::Known(node.presentation.states),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: node
                    .presentation
                    .bounds
                    .map(LocatorField::Known)
                    .unwrap_or(LocatorField::Absent),
                available_actions: LocatorField::Known(node.presentation.available_actions),
                descriptors: node.presentation.descriptors.clone(),
            },
        };
        let children = node.children.into_iter().map(subtree).collect();
        ObservedSubtree::new(
            evidence,
            children,
            !node.subtree_truncated,
            node.children_count,
        )
    }

    ObservedTree::from_roots(
        vec![subtree(node)],
        ObservationSource::from_root(root, root.surface()),
        LocatorStats::default(),
        true,
    )
}

pub(crate) fn test_report() -> crate::OperationReport {
    crate::OperationReport::delivered_unverified("test", crate::OperationTarget::Clipboard)
}
