use super::*;
use crate::adapter::AdAdapter;
use crate::types::{AdExactWindowInfo, AdFindQuery, AdFindSelectionKind, AdRect, AdWindowInfo};
use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, ObservationRequest,
    ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
};

struct DuplicateAdapter;

impl ActionOps for DuplicateAdapter {}
impl InputOps for DuplicateAdapter {}
impl SystemOps for DuplicateAdapter {}

impl ObservationOps for DuplicateAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, agent_desktop_core::AdapterError> {
        let ObservationRoot::Window(window) = root else {
            return Err(agent_desktop_core::AdapterError::internal(
                "expected window root",
            ));
        };
        ObservedTree::from_roots(
            vec![
                button(vec!["selected".into()]),
                button(vec!["disabled".into()]),
            ],
            ObservationSource::Window {
                window: window.clone(),
                surface: agent_desktop_core::SnapshotSurface::Window,
            },
            Default::default(),
            true,
        )
    }
}

fn button(states: Vec<String>) -> ObservedSubtree {
    ObservedSubtree::new(
        LocatorEvidence {
            role: LocatorField::Known("button".into()),
            name: LocatorField::Known("Save".into()),
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(states),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(vec!["Click".into()]),
                descriptors: Default::default(),
            },
        },
        Vec::new(),
        true,
        None,
    )
}

fn window() -> AdExactWindowInfo {
    AdExactWindowInfo {
        version: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_VERSION,
        size: crate::types::exact_window_info::AD_EXACT_WINDOW_INFO_SIZE as u32,
        window: AdWindowInfo {
            id: c"w-1".as_ptr(),
            title: c"Fixture".as_ptr(),
            app_name: c"Fixture".as_ptr(),
            pid: 42,
            bounds: AdRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            has_bounds: false,
            is_focused: false,
        },
        process_instance: c"42:100".as_ptr(),
        accessible: true,
    }
}

fn query() -> AdFindQuery {
    let mut query = unsafe { std::mem::zeroed::<AdFindQuery>() };
    query.control.version = crate::types::find_query::AD_FIND_QUERY_VERSION;
    query.control.selection.kind = AdFindSelectionKind::Strict as i32;
    query.control.timeout_ms = 1_000;
    query.filter.identity.name = c"Save".as_ptr();
    query
}

#[test]
fn strict_duplicate_is_ambiguous_at_the_c_boundary() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(DuplicateAdapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut out = false;

    let result =
        unsafe { ad_is_exact(adapter, &window(), &query(), c"enabled".as_ptr(), &mut out) };

    unsafe { crate::adapter::ad_adapter_destroy(adapter) };
    assert_eq!(result, AdResult::ErrAmbiguousTarget);
    assert!(!out);
}

#[test]
fn last_and_nth_selection_are_applied_at_the_c_boundary() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(DuplicateAdapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    for (kind, nth) in [
        (AdFindSelectionKind::Last, 0),
        (AdFindSelectionKind::Nth, 1),
    ] {
        let mut query = query();
        query.control.selection.kind = kind as i32;
        query.control.selection.nth = nth;
        let mut out = false;

        let result =
            unsafe { ad_is_exact(adapter, &window(), &query, c"disabled".as_ptr(), &mut out) };

        assert_eq!(result, AdResult::Ok);
        assert!(out);
    }
    unsafe { crate::adapter::ad_adapter_destroy(adapter) };
}

#[test]
fn first_selection_reports_selected_at_the_c_boundary() {
    let adapter = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(DuplicateAdapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut query = query();
    query.control.selection.kind = AdFindSelectionKind::First as i32;
    let mut out = false;

    let result = unsafe { ad_is_exact(adapter, &window(), &query, c"selected".as_ptr(), &mut out) };

    unsafe { crate::adapter::ad_adapter_destroy(adapter) };
    assert_eq!(result, AdResult::Ok);
    assert!(out);
}
