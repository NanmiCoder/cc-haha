use agent_desktop_core::{ActionOps, InputOps, ObservationOps, PlatformAdapter, SystemOps};
use agent_desktop_core::{
    ActionRequest, ActionResult, AdapterError, Deadline, ElementState, ErrorCode,
    IdentifierEvidence, InteractionLease, LiveElement, LiveIdentity, LocatorField, NativeHandle,
    Rect, RefCapabilities, RefEntry, RefEntryIdentity, RefGeometry, RefProcess, RefScope,
    RefSource, SnapshotSurface, actions::capability,
};
use std::sync::atomic::{AtomicU32, Ordering};

#[path = "../../tests/conformance/ref_action_contract.rs"]
mod ref_action_contract;

#[path = "../../tests/conformance/window_identity_contract.rs"]
mod window_identity_contract;

#[cfg(target_os = "macos")]
#[path = "../../tests/conformance/macos_notification_contract.rs"]
mod macos_notification_contract;

struct ContractAdapter {
    resolve: ResolveMode,
    live_bounds: Option<Rect>,
    live_value: Option<String>,
    dispatches: AtomicU32,
}

#[derive(Clone, Copy)]
enum ResolveMode {
    Ok,
    Stale,
    Ambiguous,
}

impl ObservationOps for ContractAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve()
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(LiveElement {
            identity: LiveIdentity {
                name: LocatorField::Known("OK".into()),
                description: LocatorField::Absent,
                identifiers: IdentifierEvidence::absent(),
            },
            state: ElementState {
                role: "button".into(),
                states: vec![],
                value: self.live_value.clone(),
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: self.live_bounds,
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Ok(Some(ElementState {
            role: "button".into(),
            states: vec![],
            value: self.live_value.clone(),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }))
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(self.live_value.clone())
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Ok(self.live_bounds)
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Ok(Some(vec![capability::CLICK.into()]))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: agent_desktop_core::Point,
        _deadline: Deadline,
    ) -> Result<agent_desktop_core::HitTestResult, AdapterError> {
        Ok(agent_desktop_core::HitTestResult::ReachesTarget)
    }
}

impl ActionOps for ContractAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for ContractAdapter {}

impl SystemOps for ContractAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }
}

impl ContractAdapter {
    fn new(resolve: ResolveMode, live_bounds: Option<Rect>) -> Self {
        Self {
            resolve,
            live_bounds,
            live_value: None,
            dispatches: AtomicU32::new(0),
        }
    }

    fn with_live_value(mut self, value: &str) -> Self {
        self.live_value = Some(value.into());
        self
    }

    fn resolve(&self) -> Result<NativeHandle, AdapterError> {
        match self.resolve {
            ResolveMode::Ok => Ok(NativeHandle::null()),
            ResolveMode::Stale => Err(AdapterError::new(ErrorCode::StaleRef, "stale ref")),
            ResolveMode::Ambiguous => Err(AdapterError::ambiguous_target("2 candidates matched")),
        }
    }
}

fn entry(bounds: Rect) -> RefEntry {
    RefEntry {
        process: RefProcess {
            pid: agent_desktop_core::ProcessId::new(1),
            process_instance: Some("contract-process".into()),
        },
        identity: RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("OK".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: RefScope {
            root_ref: None,
            path_is_absolute: true,
            path: Default::default(),
        },
    }
}

#[test]
fn platform_adapter_exposes_all_capability_methods() {
    fn exercise(adapter: &dyn PlatformAdapter) {
        let deadline = Deadline::standard().unwrap();
        let windows = adapter
            .list_windows(
                &agent_desktop_core::WindowFilter {
                    focused_only: false,
                    app: None,
                },
                deadline,
            )
            .expect_err("an adapter without window listing reports it unsupported");
        assert_eq!(windows.code, ErrorCode::PlatformNotSupported);
        let apps = adapter
            .list_apps(deadline)
            .expect_err("an adapter without app listing reports it unsupported");
        assert_eq!(apps.code, ErrorCode::PlatformNotSupported);
        let permissions = adapter
            .permission_report(deadline)
            .expect("the default permission report is readable through the dyn surface");
        assert!(matches!(
            permissions.accessibility,
            agent_desktop_core::PermissionState::Unknown
        ));
        let clipboard = adapter
            .get_clipboard_content(agent_desktop_core::ClipboardFormat::Text, deadline)
            .expect_err("an adapter without a clipboard reports it unsupported");
        assert_eq!(clipboard.code, ErrorCode::PlatformNotSupported);
        let handle = adapter
            .resolve_element_strict(&entry(Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            }), deadline)
            .expect("ObservationOps::resolve_element_strict must be reachable through &dyn PlatformAdapter");
        let lease = adapter.acquire_interaction_lease(deadline).unwrap();
        let result = adapter
            .execute_action(
                &handle,
                ActionRequest::headless(agent_desktop_core::Action::Click),
                &lease,
            )
            .expect("ActionOps::execute_action must be reachable through &dyn PlatformAdapter");
        assert_eq!(result.action, "click");
    }
    let adapter = ContractAdapter::new(
        ResolveMode::Ok,
        Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }),
    );
    exercise(&adapter);
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
}

#[test]
fn adapter_contract_dispatches_when_live_identity_moved() {
    let snapshot_bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let adapter = ContractAdapter::new(
        ResolveMode::Ok,
        Some(Rect {
            x: 100.0,
            y: 100.0,
            width: 20.0,
            height: 20.0,
        }),
    );

    let result = ref_action_contract::run_click_command(&adapter, entry(snapshot_bounds)).unwrap();

    assert_eq!(result["action"], "click");
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
}

#[test]
fn adapter_contract_dispatches_when_live_identity_is_stable() {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let adapter = ContractAdapter::new(ResolveMode::Ok, Some(bounds));

    let result = ref_action_contract::run_click_command(&adapter, entry(bounds)).unwrap();

    assert_eq!(result["action"], "click");
    assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 1);
}

#[test]
fn adapter_contract_resolution_failures_stop_before_dispatch() {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    for (mode, code) in [
        (ResolveMode::Stale, "STALE_REF"),
        (ResolveMode::Ambiguous, "AMBIGUOUS_TARGET"),
    ] {
        let adapter = ContractAdapter::new(mode, Some(bounds));

        let err = ref_action_contract::run_click_command(&adapter, entry(bounds)).unwrap_err();

        assert_eq!(err.code(), code);
        assert_eq!(adapter.dispatches.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn adapter_contract_wait_element_uses_session_snapshot() {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let adapter = ContractAdapter::new(ResolveMode::Ok, Some(bounds));
    let context =
        agent_desktop_core::context::CommandContext::new(Some("shared-agent".into()), None, false)
            .unwrap();

    let result =
        ref_action_contract::run_wait_element_command(&adapter, entry(bounds), &context).unwrap();

    assert_eq!(result["found"], true);
    assert!(
        result["ref"]
            .as_str()
            .is_some_and(|ref_id| ref_id.starts_with("@s") && ref_id.ends_with(":e1"))
    );
    assert_eq!(result["predicate"], "exists");
}

#[test]
fn adapter_contract_wait_predicates_cover_live_state_paths() {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let context =
        agent_desktop_core::context::CommandContext::new(Some("shared-agent".into()), None, false)
            .unwrap();

    let enabled = ref_action_contract::run_wait_element_command_with_predicate(
        &ContractAdapter::new(ResolveMode::Ok, Some(bounds)),
        entry(bounds),
        &context,
        ref_action_contract::WaitPredicate::new("enabled"),
    )
    .unwrap();
    let actionable = ref_action_contract::run_wait_element_command_with_predicate(
        &ContractAdapter::new(ResolveMode::Ok, Some(bounds)),
        entry(bounds),
        &context,
        ref_action_contract::WaitPredicate::new("actionable").with_action("click"),
    )
    .unwrap();
    let value = ref_action_contract::run_wait_element_command_with_predicate(
        &ContractAdapter::new(ResolveMode::Ok, Some(bounds)).with_live_value("ready"),
        entry(bounds),
        &context,
        ref_action_contract::WaitPredicate::new("value").with_value("ready"),
    )
    .unwrap();

    assert_eq!(enabled["observed"]["enabled"], true);
    assert_eq!(actionable["observed"]["actionable"], true);
    assert_eq!(value["observed"]["matched"], true);
}
