use super::*;
use crate::{
    AdapterError, ErrorCode,
    actions::action::Action,
    actions::capability,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps},
};
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn oversized_timeout_budget_is_clamped_and_never_overflows() {
    assert_eq!(crate::Deadline::after(100).unwrap().timeout_ms(), 100);
    assert_eq!(
        crate::Deadline::after(u64::MAX).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
}

#[test]
fn actionability_timeout_exposes_the_last_report_contract() {
    let error = crate::ref_action::ref_action_poll::timeout_with_last_report(serde_json::json!({
        "phase": "preflight"
    }));

    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("last_report")),
        Some(&serde_json::json!({ "phase": "preflight" }))
    );
    assert!(
        error
            .details
            .as_ref()
            .is_none_or(|details| details.get("report").is_none())
    );
}

struct RetryAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for RetryAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if self.resolve_calls.load(Ordering::SeqCst) < 3 {
            return Err(AdapterError::new(ErrorCode::StaleRef, "not yet")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for RetryAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for RetryAdapter {}

impl SystemOps for RetryAdapter {
    crate::adapter::guarded_interaction_lease!();
}

struct AmbiguousThenOkAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for AmbiguousThenOkAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        if self.resolve_calls.load(Ordering::SeqCst) == 1 {
            return Err(AdapterError::ambiguous_target("2 candidates")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for AmbiguousThenOkAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for AmbiguousThenOkAdapter {}

impl SystemOps for AmbiguousThenOkAdapter {
    crate::adapter::guarded_interaction_lease!();
}

fn entry() -> RefEntry {
    let bounds = crate::Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
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
            source_app: Some("Fixture".into()),
            source_window_id: Some("w-1".into()),
            source_window_title: Some("Fixture".into()),
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

fn request_with_timeout(timeout_ms: u64) -> ActionRequest {
    ActionRequest::headless(Action::Click).with_timeout_ms(Some(timeout_ms))
}

#[test]
fn none_timeout_uses_single_resolve_attempt() {
    let adapter = RetryAdapter {
        resolve_calls: AtomicU32::new(0),
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
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
    assert_eq!(err.code, ErrorCode::StaleRef);
}

#[test]
fn transient_ambiguity_is_recorded_in_result_details() {
    let adapter = AmbiguousThenOkAdapter {
        resolve_calls: AtomicU32::new(0),
    };
    let result = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request_with_timeout(5_000),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap();
    assert_eq!(
        result
            .details
            .as_ref()
            .and_then(|d| d.get("transient_ambiguity")),
        Some(&serde_json::json!(true))
    );
}

struct DisabledPolicyBlockedAdapter {
    preflight_reads: AtomicU32,
}

impl ObservationOps for DisabledPolicyBlockedAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<crate::LiveElement, AdapterError> {
        self.preflight_reads.fetch_add(1, Ordering::SeqCst);
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: crate::ElementState {
                role: "button".into(),
                states: Vec::new(),
                value: None,
                enabled: Some(false),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(crate::Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            }),
            available_actions: vec![capability::CLICK.into()],
        })
    }
}

impl ActionOps for DisabledPolicyBlockedAdapter {}
impl InputOps for DisabledPolicyBlockedAdapter {}
impl SystemOps for DisabledPolicyBlockedAdapter {}

/// Regression for a target that is simultaneously disabled (transient,
/// waitable) and policy-blocked (permanent): `terminal_code()` used to
/// surface the first blocking check it found rather than the most severe
/// one, so this misread as a retryable `ActionFailed` and the auto-wait
/// loop polled it until the entire wait budget was gone. It must instead
/// classify as the permanent `PolicyDenied` on the first read and return
/// immediately.
#[test]
fn policy_denied_disabled_target_fails_fast_without_exhausting_wait_budget() {
    let adapter = DisabledPolicyBlockedAdapter {
        preflight_reads: AtomicU32::new(0),
    };
    let started = std::time::Instant::now();
    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::RightClick).with_timeout_ms(Some(5_000)),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert_eq!(adapter.preflight_reads.load(Ordering::SeqCst), 1);
    assert!(
        started.elapsed().as_millis() < 500,
        "fail-fast target should not consume the wait budget, took {:?}",
        started.elapsed()
    );
}

struct SettledStaleAdapter {
    resolve_calls: AtomicU32,
}

impl ObservationOps for SettledStaleAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.resolve_calls.fetch_add(1, Ordering::SeqCst);
        Err(
            AdapterError::stale_ref_because("Stored ref does not match any live element")
                .with_details(serde_json::json!({
                    "kind": "resolve_no_candidate",
                    "complete": true,
                    "retryable": true,
                })),
        )
    }

    crate::adapter::complete_live_observation!("button", "Run", [capability::CLICK]);
}

impl ActionOps for SettledStaleAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for SettledStaleAdapter {}

impl SystemOps for SettledStaleAdapter {
    crate::adapter::guarded_interaction_lease!();
}

/// A ref that stays unresolvable through a complete search must surface the
/// settled `STALE_REF` when the budget runs out, not a `TIMEOUT` claiming the
/// application may be busy: the resolver already proved the target is gone,
/// and the polling loop must not discard that diagnosis.
#[test]
fn complete_no_candidate_returns_stale_ref_without_exhausting_budget() {
    let adapter = SettledStaleAdapter {
        resolve_calls: AtomicU32::new(0),
    };
    let err = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request_with_timeout(300),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::StaleRef);
    assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
    let details = err.details.expect("settled details");
    assert_eq!(details["kind"], "resolve_no_candidate");
    assert_eq!(details["complete"], true);
    assert_eq!(adapter.resolve_calls.load(Ordering::SeqCst), 1);
}

#[path = "ref_action_wait_lease_tests.rs"]
mod lease_tests;

#[path = "ref_action_wait_unresponsive_tests.rs"]
mod unresponsive_tests;

#[path = "ref_action_wait_stale_tests.rs"]
mod stale_tests;
