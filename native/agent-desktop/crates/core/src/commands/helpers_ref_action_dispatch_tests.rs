use super::test_support::{entry, text_entry};
use super::*;
use crate::AdapterError;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::refs::RefMap;
use crate::refs::refs_test_support::HomeGuard;
use crate::{
    actions::action::Action, actions::action_result::ActionResult,
    actions::action_step::ActionStep, actions::interaction_policy::InteractionPolicy,
    tree::element_state::ElementState,
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

struct RecordingAdapter {
    request: Mutex<Option<ActionRequest>>,
}

impl ObservationOps for RecordingAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "OK",
        [crate::actions::capability::CLICK, crate::actions::capability::TYPE_TEXT],
        adapter => ElementState {
            role: "textfield".into(),
            states: vec!["focused".into()],
            value: Some(
                adapter
                    .request
                    .lock()
                    .unwrap()
                    .as_ref()
                    .and_then(|request| match &request.action {
                        Action::TypeText(text) => Some(text.clone()),
                        _ => None,
                    })
                    .unwrap_or_default(),
            ),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
}

impl ActionOps for RecordingAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        *self.request.lock().unwrap() = Some(request);
        Ok(ActionResult::delivered_unverified("ok")
            .with_state(ElementState {
                role: "textfield".into(),
                states: vec!["focused".into()],
                value: Some("updated".into()),
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            })
            .with_steps(vec![ActionStep::succeeded("AXPress")]))
    }
}

impl InputOps for RecordingAdapter {}

impl SystemOps for RecordingAdapter {
    crate::adapter::guarded_interaction_lease!();
}

struct AmbiguousAdapter {
    executed: AtomicU32,
}

impl ObservationOps for AmbiguousAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(
            AdapterError::ambiguous_target("2 candidates matched").with_details(
                serde_json::json!({
                    "candidate_count": 2,
                    "candidates": [{ "name": "Private OK" }]
                }),
            ),
        )
    }
}

impl ActionOps for AmbiguousAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.executed.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("unexpected"))
    }
}

impl InputOps for AmbiguousAdapter {}

impl SystemOps for AmbiguousAdapter {
    crate::adapter::guarded_interaction_lease!();
}

#[test]
fn execute_ref_action_preserves_action_and_policy() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    let mut target = text_entry();
    target
        .capabilities
        .available_actions
        .push(crate::actions::capability::CLICK.into());
    refmap.allocate(target);
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = RecordingAdapter {
        request: Mutex::new(None),
    };
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &CommandContext::default(),
    )
    .unwrap();

    let request = adapter.request.lock().unwrap().clone().unwrap();
    assert!(matches!(request.action, Action::Click));
    assert_eq!(request.policy, InteractionPolicy::headless());
}

#[test]
fn execute_ref_action_does_not_dispatch_ambiguous_target() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    refmap.allocate(entry());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = AmbiguousAdapter {
        executed: AtomicU32::new(0),
    };
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let err = execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &CommandContext::default(),
    )
    .expect_err("ambiguous targets fail before action dispatch");

    assert_eq!(err.code(), "AMBIGUOUS_TARGET");
    assert_eq!(adapter.executed.load(Ordering::SeqCst), 0);
}

#[test]
fn ref_action_trace_includes_ambiguous_details_without_candidate_names() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    refmap.allocate(entry());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = AmbiguousAdapter {
        executed: AtomicU32::new(0),
    };
    let trace_path = std::env::temp_dir().join(format!(
        "agent-desktop-ambiguous-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(trace_path.clone()), true).unwrap();
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    let err = execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::headless(Action::Click),
        &context,
    )
    .expect_err("ambiguous targets fail before action dispatch");

    assert_eq!(err.code(), "AMBIGUOUS_TARGET");
    let trace = std::fs::read_to_string(&trace_path).unwrap();
    assert!(trace.contains("\"candidate_count\":2"));
    assert!(!trace.contains("Private OK"));
    let _ = std::fs::remove_file(trace_path);
}

#[test]
fn ref_action_trace_does_not_include_typed_text_payload() {
    let _guard = HomeGuard::new();
    let mut refmap = RefMap::new();
    refmap.allocate(text_entry());
    let snapshot_id = RefStore::new().unwrap().save_new_snapshot(&refmap).unwrap();
    let adapter = RecordingAdapter {
        request: Mutex::new(None),
    };
    let trace_path = std::env::temp_dir().join(format!(
        "agent-desktop-type-trace-{}.jsonl",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let context = CommandContext::new(None, Some(trace_path.clone()), true).unwrap();
    let args = RefArgs {
        ref_id: format!("@{}:e1", snapshot_id),
        timeout_ms: None,
    };

    execute_ref_action_with_context(
        args,
        &adapter,
        ActionRequest::focus_fallback(Action::TypeText("super-secret".into())),
        &context,
    )
    .unwrap();

    let trace = std::fs::read_to_string(&trace_path).unwrap();
    assert!(trace.contains("\"action\":\"type\""));
    assert!(trace.contains("\"event\":\"action.dispatch.start\""));
    assert!(trace.contains("\"event\":\"action.dispatch.ok\""));
    assert!(trace.contains("\"post_state\""));
    assert!(trace.contains("\"steps\""));
    assert!(!trace.contains("super-secret"));
    let _ = std::fs::remove_file(trace_path);
}
