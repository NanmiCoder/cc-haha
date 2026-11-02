use crate::adapter::{ActionOps, InputOps, ObservationOps, PlatformAdapter, SystemOps};
use crate::commands::wait::{WaitArgs, WaitModeArgs, WaitPredicateArgs};
use crate::commands::wait_element::{ElementWaitInput, wait_for_element};
use crate::commands::wait_predicate;
use crate::{
    AdapterError, AppError, Rect,
    adapter::NativeHandle,
    context::CommandContext,
    refs::refs_store::RefStore,
    refs::{RefEntry, RefMap},
    tree::element_state::ElementState,
};
use serde_json::Value;

/// Baseline `WaitArgs` with every mode/predicate field cleared, shared by the
/// notification- and text/menu-scenario test groups so both can build a
/// specific mode via `..wait_args()` struct-update syntax.
pub(super) fn wait_args() -> WaitArgs {
    WaitArgs {
        mode: WaitModeArgs {
            ms: None,
            element: None,
            window: None,
            text: None,
            surface: None,
            event: None,
            window_id: None,
        },
        predicate: WaitPredicateArgs {
            predicate: None,
            value: None,
            action: None,
            count: None,
        },
        timeout_ms: 1,
        app: None,
    }
}

pub(super) fn wait_for_element_test(
    ref_id: String,
    snapshot_id: Option<String>,
    predicate: wait_predicate::ElementPredicate,
    timeout_ms: u64,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    wait_for_element(
        ElementWaitInput {
            ref_id: crate::refs::ref_token::qualify_for_test(&ref_id, snapshot_id.as_deref()),
            predicate,
            timeout_ms,
        },
        adapter,
        context,
    )
}

pub(super) struct PredicateAdapter {
    pub(super) state: Option<ElementState>,
    pub(super) value: Option<String>,
    pub(super) bounds: Option<Rect>,
}

impl ObservationOps for PredicateAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: self.state.clone().unwrap_or_else(|| ElementState {
                role: "button".into(),
                states: Vec::new(),
                value: self.value.clone(),
                enabled: None,
                hidden: None,
                offscreen: None,
            }),
            states_complete: true,
            bounds: self.bounds,
            available_actions: vec![crate::actions::capability::CLICK.into()],
        })
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Ok(self.state.clone())
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(self.value.clone())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(self.bounds)
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Ok(Some(vec![crate::actions::capability::CLICK.into()]))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        Ok(crate::adapter::hit_test::HitTestResult::ReachesTarget)
    }
}

impl ActionOps for PredicateAdapter {}

impl InputOps for PredicateAdapter {}

impl SystemOps for PredicateAdapter {}

pub(super) fn snapshot_with_one_ref() -> String {
    save_ref(Vec::new())
}

pub(super) fn snapshot_with_disabled_ref() -> String {
    save_ref(vec!["disabled".into()])
}

pub(super) fn save_ref(states: Vec<String>) -> String {
    save_ref_in_store(RefStore::new().unwrap(), states)
}

pub(super) fn save_ref_in_session(session_id: &str, states: Vec<String>) -> String {
    save_ref_in_store(RefStore::for_session(Some(session_id)).unwrap(), states)
}

fn save_ref_in_store(store: RefStore, states: Vec<String>) -> String {
    let mut refmap = RefMap::new();
    refmap.allocate(RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("Run".into()),
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
            states,
            available_actions: vec!["Click".into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::adapter::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    });
    store.save_new_snapshot(&refmap).unwrap()
}
