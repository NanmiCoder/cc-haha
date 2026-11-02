use super::*;
use crate::adapter::AdAdapter;
use crate::types::{
    AdExactWindowInfo, AdFindQuery, AdFindSelectionKind, AdNativeHandle, AdRect, AdWindowInfo,
};
use agent_desktop_core::{ActionOps, InputOps, ObservationOps, SystemOps};
use agent_desktop_core::{
    IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, ObservationRequest,
    ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
};

const TEST_TIMEOUT_MS: u64 = 1_000;

struct CardinalityAdapter {
    duplicate: bool,
    complete: bool,
}

impl ActionOps for CardinalityAdapter {}
impl InputOps for CardinalityAdapter {}
impl SystemOps for CardinalityAdapter {}

impl ObservationOps for CardinalityAdapter {
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
        let mut roots = vec![subtree(self.complete)];
        if self.duplicate {
            roots.push(subtree(self.complete));
        }
        ObservedTree::from_roots(
            roots,
            ObservationSource::Window {
                window: window.clone(),
                surface: agent_desktop_core::SnapshotSurface::Window,
            },
            Default::default(),
            self.complete,
        )
    }
}

fn subtree(complete: bool) -> ObservedSubtree {
    ObservedSubtree::new(
        LocatorEvidence {
            role: LocatorField::Known("button".into()),
            name: LocatorField::Known("Save".into()),
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(Vec::new()),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(vec!["Click".into()]),
                descriptors: Default::default(),
            },
        },
        Vec::new(),
        complete,
        None,
    )
}

fn ffi_window() -> AdExactWindowInfo {
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
    query.control.timeout_ms = TEST_TIMEOUT_MS;
    query.filter.identity.name = c"Save".as_ptr();
    query
}

fn call(adapter: CardinalityAdapter) -> AdResult {
    let handle = crate::adapter::register_adapter(AdAdapter {
        inner: Box::new(adapter),
        session_id: None,
        _session_lease: None,
    })
    .unwrap();
    let mut out = AdNativeHandle {
        ptr: std::ptr::null(),
    };
    let result = unsafe { ad_find_exact(handle, &ffi_window(), &query(), &mut out) };
    unsafe { crate::adapter::ad_adapter_destroy(handle) };
    assert!(out.ptr.is_null());
    result
}

#[test]
fn strict_duplicate_is_ambiguous_at_the_c_boundary() {
    assert_eq!(
        call(CardinalityAdapter {
            duplicate: true,
            complete: true,
        }),
        AdResult::ErrAmbiguousTarget
    );
}

#[test]
fn strict_incomplete_observation_times_out_at_the_c_boundary() {
    assert_eq!(
        call(CardinalityAdapter {
            duplicate: false,
            complete: false,
        }),
        AdResult::ErrTimeout
    );
}
