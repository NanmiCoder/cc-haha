use super::{
    EvidenceRequirements, LocatorMaterialization, LocatorResolveRequest, LocatorSelection,
    ObservationRequest, ObservationRoot, validate_query, validate_request,
};
use crate::{
    ErrorCode, WindowInfo,
    adapter::ObservationOps,
    locator::{ContainmentPredicate, LocatorQuery, StatePredicate},
};

struct UnsupportedAdapter;

impl ObservationOps for UnsupportedAdapter {}

fn request(max_raw_depth: u8) -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::All { limit: None },
        deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap(),
        max_raw_depth,
        surface: None,
        materialization: LocatorMaterialization::None,
    }
}

#[test]
fn match_all_query_remains_valid() {
    validate_query(&LocatorQuery::default()).unwrap();
}

#[test]
fn recursive_state_validation_runs_before_native_work() {
    let query = LocatorQuery {
        containment: ContainmentPredicate {
            has: Some(Box::new(LocatorQuery {
                states: vec![StatePredicate {
                    token: "imaginary".into(),
                    expected: None,
                }],
                ..LocatorQuery::default()
            })),
            has_not: None,
        },
        ..LocatorQuery::default()
    };
    let error = validate_query(&query).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn recursive_query_clause_limit_is_bounded() {
    let mut query = LocatorQuery::default();
    for _ in 0..64 {
        query = LocatorQuery {
            containment: ContainmentPredicate {
                has: Some(Box::new(query)),
                has_not: None,
            },
            ..LocatorQuery::default()
        };
    }
    let error = validate_query(&query).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
}

#[test]
fn a_snapshot_depth_above_the_cap_names_the_limit_in_caller_terms() {
    let deadline = crate::Deadline::from_duration(std::time::Duration::from_secs(5)).unwrap();
    let too_deep = crate::TreeOptions {
        max_depth: 51,
        ..Default::default()
    };
    let error = ObservationRequest::snapshot(&too_deep, deadline)
        .validate()
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgs);
    assert_eq!(
        error.message,
        "max depth 51 exceeds the supported maximum of 50"
    );
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|hint| hint.contains("--root"))
    );
    let deepest = crate::TreeOptions {
        max_depth: 50,
        ..Default::default()
    };
    ObservationRequest::snapshot(&deepest, deadline)
        .validate()
        .unwrap();
}

#[test]
fn raw_depth_must_fit_native_safety_cap() {
    for invalid in [0, 51] {
        let error = validate_request(&request(invalid)).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgs);
    }
    validate_request(&request(50)).unwrap();
}

#[test]
fn tree_builder_default_is_not_supported() {
    let adapter = UnsupportedAdapter;
    let window = WindowInfo {
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
    };
    let error = match adapter.observe_tree(
        ObservationRoot::Window(&window),
        &ObservationRequest::locator(
            &LocatorQuery::default(),
            &request(50),
            crate::Deadline::standard().unwrap(),
        ),
    ) {
        Ok(_) => panic!("default implementation should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
}

#[test]
fn element_root_derives_surface_with_relative_depth_budgets() {
    let entry = crate::RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(42),
            process_instance: Some("instance-1".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "group".into(),
            name: Some("Menu root".into()),
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
            source_app: Some("Fixture".into()),
            source_window_id: Some("w-1".into()),
            source_window_title: Some("Fixture".into()),
            source_window_bounds_hash: None,
            source_surface: crate::SnapshotSurface::Menu,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: true,
            path: smallvec::smallvec![3, 4, 5],
        },
    };
    let handle = crate::NativeHandle::null();
    let root = ObservationRoot::Element {
        handle: &handle,
        entry: &entry,
        root_ref: Some("@e1"),
    };
    let locator = ObservationRequest::locator_for_root(
        &LocatorQuery::default(),
        &request(12),
        root,
        crate::Deadline::standard().unwrap(),
    );
    let hydration = ObservationRequest::selected_hydration(
        &LocatorQuery::default(),
        &request(12),
        root,
        crate::Deadline::standard().unwrap(),
    );

    assert_eq!(locator.surface, crate::SnapshotSurface::Menu);
    assert_eq!(locator.max_raw_depth, 12);
    assert_eq!(locator.max_logical_depth, 12);
    assert_eq!(hydration.surface, crate::SnapshotSurface::Menu);
    assert_eq!(hydration.max_raw_depth, 1);
    assert_eq!(hydration.max_logical_depth, 0);
    assert_eq!(
        hydration.evidence_for_raw_depth(0),
        EvidenceRequirements::snapshot()
    );
    assert_eq!(
        hydration.evidence_for_raw_depth(1),
        EvidenceRequirements::query(&LocatorQuery::default())
    );
}
