use super::*;
use crate::{
    AdapterError, ErrorCode,
    actionability::{ActionabilityCheck, ActionabilityStatus, check_live},
    actions::action::Action,
    actions::action_request::ActionRequest,
    actions::capability,
    adapter::{ActionOps, InputOps, LiveElement, NativeHandle, ObservationOps, SystemOps},
    refs::RefEntry,
    tree::element_state::ElementState,
};
use smallvec::SmallVec;
use std::collections::VecDeque;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct HitTestAdapter {
    outcome: Result<HitTestResult, AdapterError>,
    actions: Vec<String>,
    calls: AtomicUsize,
}

impl ObservationOps for HitTestAdapter {
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
    ) -> Result<LiveElement, AdapterError> {
        Ok(live_element(self.actions.clone()))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.outcome.clone()
    }
}

impl ActionOps for HitTestAdapter {}
impl InputOps for HitTestAdapter {}
impl SystemOps for HitTestAdapter {}

struct SequencedHitAdapter {
    outcomes: Mutex<VecDeque<HitTestResult>>,
    actions: Vec<String>,
    calls: AtomicUsize,
}

impl ObservationOps for SequencedHitAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(live_element(self.actions.clone()))
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self
            .outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(HitTestResult::Unknown))
    }
}

impl ActionOps for SequencedHitAdapter {}
impl InputOps for SequencedHitAdapter {}
impl SystemOps for SequencedHitAdapter {}

fn live_element(actions: Vec<String>) -> LiveElement {
    LiveElement {
        identity: crate::adapter::live_identity("Save"),
        state: ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds: Some(crate::Rect {
            x: 10.0,
            y: 10.0,
            width: 40.0,
            height: 20.0,
        }),
        available_actions: actions,
    }
}

fn clickable_entry() -> RefEntry {
    let bounds = crate::Rect {
        x: 10.0,
        y: 10.0,
        width: 40.0,
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
            name: Some("Save".into()),
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
            path: SmallVec::new(),
        },
    }
}

fn run_receives_events_check(outcome: Result<HitTestResult, AdapterError>) -> ActionabilityCheck {
    let adapter = HitTestAdapter {
        outcome,
        actions: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    let entry = clickable_entry();
    let request = ActionRequest::headed(Action::Click);
    let report = check_live(&entry, &NativeHandle::null(), &adapter, &request)
        .expect("a confirmed target hit should pass actionability");
    report
        .checks
        .into_iter()
        .find(|check| check.check == "receives_events")
        .expect("Click requires a receives_events check")
}

fn run_receives_events_error(outcome: Result<HitTestResult, AdapterError>) -> AdapterError {
    let adapter = HitTestAdapter {
        outcome,
        actions: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headed(Action::Click),
    )
    .expect_err("incomplete hit-test evidence must fail closed")
}

#[test]
fn headless_semantic_click_skips_inconclusive_screen_hit_testing() {
    let adapter = HitTestAdapter {
        outcome: Ok(HitTestResult::Unknown),
        actions: vec![capability::CLICK.into()],
        calls: AtomicUsize::new(0),
    };

    let report = check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .expect("a direct semantic click must not depend on screen hit testing");

    assert!(report.actionable);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
    assert!(
        report
            .checks
            .iter()
            .all(|check| check.check != "receives_events")
    );
}

#[test]
fn semantic_click_skips_occluded_screen_hit_testing() {
    let adapter = HitTestAdapter {
        outcome: Ok(HitTestResult::InterceptedBy {
            role: Some("window".into()),
            name: None,
            bounds: None,
        }),
        actions: vec![capability::CLICK.into()],
        calls: AtomicUsize::new(0),
    };

    let report = check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .expect("occlusion is irrelevant to a direct semantic click");

    assert!(report.actionable);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn reaches_target_result_passes_receives_events_check() {
    let check = run_receives_events_check(Ok(HitTestResult::ReachesTarget));
    assert_eq!(check.status, ActionabilityStatus::Pass);
}

#[test]
fn unknown_hit_test_result_is_non_blocking_evidence() {
    let check = run_receives_events_check(Ok(HitTestResult::Unknown));
    assert_eq!(check.status, ActionabilityStatus::Unknown);
}

#[test]
fn not_supported_hit_test_is_non_blocking_evidence() {
    let check = run_receives_events_check(Err(AdapterError::not_supported("hit_test")));
    assert_eq!(check.status, ActionabilityStatus::Unknown);
}

#[test]
fn hit_test_probe_error_is_not_reclassified() {
    let err = run_receives_events_error(Err(AdapterError::internal(
        "AXUIElementCopyElementAtPosition failed",
    )));
    assert_eq!(err.code, ErrorCode::Internal);
}

#[test]
fn intercepted_by_result_fails_and_carries_redactable_occluder() {
    let adapter = HitTestAdapter {
        outcome: Ok(HitTestResult::InterceptedBy {
            role: Some("AXSheet".into()),
            name: Some("Save changes?".into()),
            bounds: None,
        }),
        actions: Vec::new(),
        calls: AtomicUsize::new(0),
    };
    let entry = clickable_entry();
    let request = ActionRequest::headed(Action::Click);

    let err = check_live(&entry, &NativeHandle::null(), &adapter, &request)
        .expect_err("a hit outside the target's ancestor chain must fail actionability");

    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert!(err.message.contains("AXSheet"));
    assert!(!err.message.contains("Save changes?"));

    let details = err
        .details
        .expect("a Fail report attaches actionability details");
    let checks = details["checks"]
        .as_array()
        .expect("details.checks is an array");
    let receives_events = checks
        .iter()
        .find(|check| check["check"] == "receives_events")
        .expect("receives_events check must be present when Click requires a hit test");
    assert_eq!(receives_events["status"], "fail");
    assert_eq!(receives_events["occluder"]["name"], "Save changes?");
    assert_eq!(receives_events["occluder"]["role"], "AXSheet");
}

#[test]
fn mixed_unknown_and_occluded_points_block_physical_delivery() {
    let intercepted = HitTestResult::InterceptedBy {
        role: Some("sheet".into()),
        name: None,
        bounds: None,
    };
    let adapter = SequencedHitAdapter {
        outcomes: Mutex::new(VecDeque::from([
            HitTestResult::Unknown,
            intercepted.clone(),
            intercepted.clone(),
            intercepted.clone(),
            intercepted,
        ])),
        actions: Vec::new(),
        calls: AtomicUsize::new(0),
    };

    let error = check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headed(Action::Click),
    )
    .expect_err("known occlusion must not degrade to center-point delivery");
    let details = error.details.unwrap();
    let check = details["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["check"] == "receives_events")
        .unwrap();

    assert_eq!(check["status"], "unknown");
    assert_eq!(check["hit_test"]["attempted"], 5);
    assert_eq!(check["hit_test"]["unknown"], 1);
    assert_eq!(check["hit_test"]["occluded"], 4);
    assert_eq!(check["occluder"]["role"], "sheet");
    assert_eq!(
        check["reason"],
        "hit test evidence mixed unknown and occluded outcomes"
    );
}

#[test]
fn unknown_only_hit_test_evidence_never_claims_occlusion() {
    let report = check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &HitTestAdapter {
            outcome: Ok(HitTestResult::Unknown),
            actions: Vec::new(),
            calls: AtomicUsize::new(0),
        },
        &ActionRequest::headed(Action::Click),
    )
    .unwrap();
    let details = serde_json::to_value(report).unwrap();
    let check = details["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["check"] == "receives_events")
        .unwrap();

    assert_eq!(check["status"], "unknown");
    assert_eq!(check["reason"], "hit test result inconclusive");
    assert!(check.get("occluder").is_none());
    assert_eq!(check["hit_test"]["unknown"], 5);
    assert_eq!(check["hit_test"]["occluded"], 0);
}

#[test]
fn terminal_capability_policy_failure_skips_hit_testing() {
    let adapter = SequencedHitAdapter {
        outcomes: Mutex::new(VecDeque::new()),
        actions: Vec::new(),
        calls: AtomicUsize::new(0),
    };

    let error = check_live(
        &clickable_entry(),
        &NativeHandle::null(),
        &adapter,
        &ActionRequest::headless(Action::Click),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 0);
}
