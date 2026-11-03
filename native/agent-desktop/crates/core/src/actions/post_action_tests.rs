use super::*;
use crate::{ActionOps, ActionStep, Deadline, InputOps, ObservationOps, SystemOps};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Adapter {
    before: Result<LiveElement, AdapterError>,
    after: Result<LiveElement, AdapterError>,
    selection: Option<std::ops::Range<usize>>,
    execution: Result<ActionResult, AdapterError>,
    calls: AtomicUsize,
    reads: std::sync::Mutex<Vec<Deadline>>,
    settling: std::sync::Mutex<std::collections::VecDeque<LiveElement>>,
}

impl ObservationOps for Adapter {
    fn get_live_element(
        &self,
        _: &NativeHandle,
        deadline: Deadline,
    ) -> Result<LiveElement, AdapterError> {
        self.reads.lock().unwrap().push(deadline);
        if self.calls.load(Ordering::SeqCst) == 0 {
            self.before.clone()
        } else {
            self.settling
                .lock()
                .unwrap()
                .pop_front()
                .map(Ok)
                .unwrap_or_else(|| self.after.clone())
        }
    }

    fn get_text_selection(
        &self,
        _: &NativeHandle,
        _: Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        Ok(self.selection.clone())
    }
}

impl ActionOps for Adapter {
    fn execute_action(
        &self,
        _: &NativeHandle,
        _: ActionRequest,
        _: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.execution.clone()
    }
}

impl InputOps for Adapter {}
impl SystemOps for Adapter {}

fn element(value: Option<&str>, states: &[&str]) -> LiveElement {
    LiveElement {
        identity: crate::adapter::live_identity("field"),
        state: crate::ElementState {
            role: "textfield".into(),
            states: states.iter().map(|s| s.to_string()).collect(),
            value: value.map(str::to_string),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds: None,
        available_actions: vec![],
    }
}

fn adapter(before: LiveElement, after: LiveElement) -> Adapter {
    Adapter {
        before: Ok(before),
        after: Ok(after),
        selection: None,
        execution: Ok(ActionResult::delivered_unverified("test")),
        calls: AtomicUsize::new(0),
        reads: Default::default(),
        settling: Default::default(),
    }
}

fn execute(adapter: &Adapter, action: Action) -> Result<ActionResult, AdapterError> {
    execute_verified_action(
        adapter,
        &NativeHandle::null(),
        ActionRequest::headless(action),
        &InteractionLease::guarded(Deadline::after(1000).unwrap(), ()).unwrap(),
    )
}

#[test]
fn adapter_success_cannot_override_contradictory_fresh_state() {
    for (action, before, after) in [
        (
            Action::TypeText("new".into()),
            element(Some(""), &[]),
            element(Some(""), &[]),
        ),
        (
            Action::SetValue("new".into()),
            element(Some("old"), &[]),
            element(Some("partial"), &[]),
        ),
        (
            Action::Clear,
            element(Some("old"), &[]),
            element(Some("old"), &[]),
        ),
        (Action::Check, element(None, &[]), element(None, &[])),
        (
            Action::Uncheck,
            element(None, &["checked"]),
            element(None, &["checked"]),
        ),
        (
            Action::Toggle,
            element(None, &["checked"]),
            element(None, &["checked"]),
        ),
        (Action::Expand, element(None, &[]), element(None, &[])),
        (
            Action::Collapse,
            element(None, &["expanded"]),
            element(None, &["expanded"]),
        ),
    ] {
        let adapter = adapter(before, after);
        let typed = matches!(action, Action::TypeText(_));
        let error = execute(&adapter, action).unwrap_err();
        assert_eq!(
            error
                .suggestion
                .as_deref()
                .unwrap_or("")
                .contains("set-value"),
            typed
        );
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        assert!(error.details.unwrap()["post_state"].is_object());
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn text_selection_replacement_is_verified_and_returns_the_actual_value() {
    let mut adapter = adapter(element(Some("a😀b"), &[]), element(Some("aXb"), &[]));
    adapter.selection = Some(1..3);
    let result = execute(&adapter, Action::TypeText("X".into())).unwrap();
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_verified()
    );
    assert_eq!(result.post_state.unwrap().value.as_deref(), Some("aXb"));
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    assert!(expected_insertion("😀", "X", Some(1..1)).is_none());
    assert!(expected_insertion("a", "X", Some(0..3)).is_none());
    assert!(expected_insertion("contains X", "X", None).is_none());
}

#[test]
fn absent_or_incomplete_evidence_cannot_be_verified() {
    let mut incomplete = element(None, &[]);
    incomplete.states_complete = false;
    for (action, after) in [
        (Action::SetValue("new".into()), element(None, &[])),
        (Action::Uncheck, incomplete),
    ] {
        let adapter = adapter(element(Some(""), &[]), after);
        let result = execute(&adapter, action).unwrap();
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(result.details.unwrap()["verification_scope"], "unavailable");
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn native_errors_keep_postcondition_evidence_without_repeating_delivery() {
    for (action, value, satisfied) in [
        (Action::TypeText("requested".into()), "partial", false),
        (Action::SetValue("requested".into()), "requested", true),
    ] {
        let mut adapter = adapter(element(Some(""), &[]), element(Some(value), &[]));
        adapter.execution = Err(AdapterError::timeout("native delivery")
            .with_disposition(DeliverySemantics::uncertain()));
        let error = execute(&adapter, action).unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.disposition, DeliverySemantics::uncertain());
        let details = error.details.unwrap();
        assert_eq!(details["post_state"]["value"], value);
        assert_eq!(details["postcondition_satisfied"], satisfied);
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn post_read_errors_preserve_cause_codes_details_and_recovery_hints() {
    for code in [
        ErrorCode::StaleRef,
        ErrorCode::AppUnresponsive,
        ErrorCode::Timeout,
        ErrorCode::PermDenied,
    ] {
        let mut adapter = adapter(element(Some("old"), &[]), element(None, &[]));
        adapter.after = Err(AdapterError::new(code.clone(), "readback failed")
            .with_platform_detail("native cause")
            .with_details(serde_json::json!({"cause_evidence": "kept"}))
            .with_suggestion("original recovery"));
        let error = execute(&adapter, Action::Clear).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.platform_detail.as_deref(), Some("native cause"));
        assert_eq!(error.suggestion.as_deref(), Some("original recovery"));
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        let details = error.details.unwrap();
        assert_eq!(details["cause_evidence"], "kept");
        assert_eq!(details["kind"], "post_action_verification");
        assert!(details.get("post_state").is_none());
    }
}

#[test]
fn secure_text_writes_succeed_without_claiming_value_verification() {
    for action in [
        Action::SetValue("private".into()),
        Action::Clear,
        Action::TypeText("private".into()),
    ] {
        let expected_reads = if matches!(action, Action::TypeText(_)) {
            2
        } else {
            1
        };
        let mut adapter = adapter(element(None, &["secure"]), element(None, &["secure"]));
        adapter.execution = Ok(ActionResult::delivered_unverified("test").with_verified_delivery());
        let result = execute(&adapter, action).expect("redacted readback is not a failed write");
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(result.post_state.as_ref().unwrap().value, None);
        assert_eq!(
            result.details.as_ref().unwrap()["verification_reason"],
            "secure_field"
        );
        assert_eq!(
            result.details.as_ref().unwrap()["verification_scope"],
            "unavailable"
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("private"));
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.reads.lock().unwrap().len(), expected_reads);
    }
}

#[test]
fn secure_field_redaction_does_not_hide_delivery_errors() {
    let mut adapter = adapter(element(None, &["secure"]), element(None, &["secure"]));
    adapter.execution =
        Err(AdapterError::timeout("write").with_disposition(DeliverySemantics::uncertain()));
    let error = execute(&adapter, Action::SetValue("private".into())).unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn missing_selection_does_not_turn_delivered_text_into_a_failure() {
    let adapter = adapter(element(Some("old"), &[]), element(Some("oldnew"), &[]));
    let result = execute(&adapter, Action::TypeText("new".into())).unwrap();
    assert_eq!(
        result.disposition(),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        result.details.unwrap()["verification_reason"],
        "insufficient_evidence"
    );
    assert_eq!(adapter.reads.lock().unwrap().len(), 2);
}

#[test]
fn satisfied_actions_and_pre_delivery_errors_do_not_claim_delivery() {
    let mut adapter = adapter(element(Some(""), &[]), element(Some(""), &[]));
    adapter.execution = Ok(ActionResult::satisfied_without_delivery("clear"));
    assert_eq!(
        execute(&adapter, Action::Clear).unwrap().disposition(),
        DeliverySemantics::not_delivered()
    );
    adapter.execution = Err(AdapterError::timeout("before delivery")
        .with_disposition(DeliverySemantics::not_delivered()));
    adapter.reads.lock().unwrap().clear();
    let error = execute(&adapter, Action::Clear).unwrap_err();
    assert_eq!(error.message, "before delivery");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(adapter.reads.lock().unwrap().len(), 0);
}

#[test]
fn numeric_coercion_is_verified_by_live_readback() {
    let mut observed = element(Some("1.0"), &[]);
    observed.state.role = "slider".into();
    let adapter = adapter(element(Some("0"), &[]), observed);
    assert_eq!(
        execute(&adapter, Action::SetValue("1".into()))
            .unwrap()
            .disposition(),
        DeliverySemantics::delivered_verified()
    );
}

#[test]
fn missing_before_evidence_does_not_block_or_repeat_headed_or_headless_delivery() {
    for request in [
        ActionRequest::headless(Action::TypeText("new".into())),
        ActionRequest::headed(Action::TypeText("new".into())),
    ] {
        let mut adapter = adapter(element(Some(""), &[]), element(Some("new"), &[]));
        adapter.before = Err(AdapterError::timeout("before read"));
        let result = execute_verified_action(
            &adapter,
            &NativeHandle::null(),
            request,
            &InteractionLease::guarded(Deadline::after(1000).unwrap(), ()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.disposition(),
            DeliverySemantics::delivered_unverified()
        );
        assert_eq!(adapter.calls.load(Ordering::SeqCst), 1);
        assert_eq!(adapter.reads.lock().unwrap().len(), 2);
    }
}

#[test]
fn clicks_do_not_read_a_target_that_navigation_can_destroy() {
    let adapter = adapter(element(None, &[]), element(None, &[]));
    execute(&adapter, Action::Click).unwrap();
    assert_eq!(adapter.reads.lock().unwrap().len(), 0);
}

#[path = "post_action_focus_tests.rs"]
mod focus_tests;

#[path = "post_action_budget_tests.rs"]
mod budget_tests;

#[path = "post_action_text_tests.rs"]
mod text_tests;

/// A newline left in a field is content, so a clear that leaves one is not
/// verified; a RichEdit's own terminator is removed where the value is read.
#[test]
fn clear_that_leaves_a_newline_is_not_verified() {
    let adapter = adapter(element(Some("old"), &[]), element(Some("\n"), &[]));
    let error = execute(&adapter, Action::Clear).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}
