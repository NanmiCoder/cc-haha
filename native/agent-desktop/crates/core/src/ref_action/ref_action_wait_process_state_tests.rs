use super::*;
use crate::{
    AdapterError, AppInfo, ErrorCode,
    actions::action::Action,
    actions::capability,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicU32, Ordering};

fn entry() -> RefEntry {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    RefEntry {
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
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: Some("Original".into()),
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: crate::snapshot::snapshot_surface::SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: false,
            path: smallvec::SmallVec::new(),
        },
    }
}

struct UnresponsiveProcessAdapter {
    probe_calls: AtomicU32,
    inventory_calls: AtomicU32,
}

impl ObservationOps for UnresponsiveProcessAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.inventory_calls.fetch_add(1, Ordering::SeqCst);
        Ok(vec![app("Original")])
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::stale_ref("@e1"))
    }
}

fn app(name: &str) -> AppInfo {
    AppInfo {
        name: name.into(),
        pid: crate::ProcessId::new(1),
        bundle_id: None,
        process_instance: Some("test-instance".into()),
        presentation: None,
    }
}

impl ActionOps for UnresponsiveProcessAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for UnresponsiveProcessAdapter {}

impl SystemOps for UnresponsiveProcessAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        Ok(crate::system::process_state::ProcessState::Unresponsive)
    }
}

#[test]
fn terminal_stale_ref_against_unresponsive_process_surfaces_app_unresponsive() {
    let adapter = UnresponsiveProcessAdapter {
        probe_calls: AtomicU32::new(0),
        inventory_calls: AtomicU32::new(0),
    };

    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::AppUnresponsive);
    assert!(err.suggestion.is_some());
    assert_eq!(
        err.details.as_ref().and_then(|v| v["retryable"].as_bool()),
        Some(false)
    );
    assert_eq!(
        err.details.as_ref().and_then(|v| v["kind"].as_str()),
        Some("app_unresponsive")
    );
    assert!(!err.permits_retry_by_default());
    assert_eq!(
        adapter.probe_calls.load(Ordering::SeqCst),
        1,
        "the liveness probe must run exactly once when building the terminal error"
    );
    assert_eq!(adapter.inventory_calls.load(Ordering::SeqCst), 1);
}

struct RecycledPidAdapter {
    probe_calls: AtomicU32,
    inventory_calls: AtomicU32,
}

impl ObservationOps for RecycledPidAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.inventory_calls.fetch_add(1, Ordering::SeqCst);
        Ok(vec![app("Replacement")])
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::stale_ref("@e1"))
    }
}

impl ActionOps for RecycledPidAdapter {}
impl InputOps for RecycledPidAdapter {}

impl SystemOps for RecycledPidAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        self.probe_calls.fetch_add(1, Ordering::SeqCst);
        Ok(crate::system::process_state::ProcessState::Unresponsive)
    }
}

#[test]
fn recycled_pid_never_upgrades_stale_ref_to_app_unresponsive() {
    let adapter = RecycledPidAdapter {
        probe_calls: AtomicU32::new(0),
        inventory_calls: AtomicU32::new(0),
    };

    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(adapter.probe_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.inventory_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn unresponsive_enrichment_preserves_delivery_evidence() {
    use crate::DeliverySemantics;

    let adapter = UnresponsiveProcessAdapter {
        probe_calls: AtomicU32::new(0),
        inventory_calls: AtomicU32::new(0),
    };
    for disposition in [
        DeliverySemantics::Unknown,
        DeliverySemantics::NotDelivered,
        DeliverySemantics::DeliveryUncertain,
        DeliverySemantics::DeliveredUnverified,
        DeliverySemantics::DeliveredVerified,
    ] {
        let error = enrich_with_process_state(
            &adapter,
            &entry(),
            AdapterError::stale_ref("post-action read").with_disposition(disposition),
            Deadline::standard().unwrap(),
        );
        assert_eq!(error.code, ErrorCode::AppUnresponsive);
        assert_eq!(error.disposition, disposition);
    }
}

struct TerminatedProcessAdapter(crate::system::process_state::ProcessState);

impl ObservationOps for TerminatedProcessAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::stale_ref("@e1"))
    }
}

impl ActionOps for TerminatedProcessAdapter {}
impl InputOps for TerminatedProcessAdapter {}

impl SystemOps for TerminatedProcessAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn process_state(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: crate::Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        Ok(self.0)
    }
}

#[test]
fn terminal_stale_ref_preserves_exited_and_crashed_process_details() {
    for (state, label) in [
        (
            crate::system::process_state::ProcessState::Exited { code: None },
            "exited",
        ),
        (
            crate::system::process_state::ProcessState::Crashed { signal_or_code: 11 },
            "crashed",
        ),
    ] {
        let err = execute_with_auto_wait(
            RefActionWaitCtx {
                adapter: &TerminatedProcessAdapter(state),
                entry: &entry(),
                ref_id: "@e1",
                context: &CommandContext::default(),
            },
            ActionRequest::headless(Action::Click),
            crate::ref_action::dispatch_resolved,
        )
        .unwrap_err();

        assert_eq!(err.code, ErrorCode::StaleRef);
        assert_eq!(
            err.details.as_ref().and_then(|d| d.get("process_state")),
            Some(&serde_json::json!(label))
        );
    }
}
