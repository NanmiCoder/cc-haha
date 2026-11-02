use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::commands::helpers::test_support::save_one_ref_snapshot;
use crate::{
    AdapterError, actions::action_request::ActionRequest, actions::action_result::ActionResult,
    adapter::NativeHandle, commands::stale_retry_test_support::StaleRetryCounter, refs::RefEntry,
    refs::refs_test_support::HomeGuard,
};
use std::sync::Mutex;

struct StaleThenOkAdapter {
    retry: StaleRetryCounter,
    value: Mutex<String>,
    policies: Mutex<Vec<crate::InteractionPolicy>>,
    expected_processes: Mutex<Vec<bool>>,
}

impl StaleThenOkAdapter {
    fn new(fail_until: u32) -> Self {
        Self {
            retry: StaleRetryCounter::new(fail_until),
            value: Mutex::new(String::new()),
            policies: Mutex::new(Vec::new()),
            expected_processes: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for StaleThenOkAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        self.retry.attempt()
    }

    crate::adapter::complete_live_observation!(
        "textfield",
        "Target",
        [crate::actions::capability::TYPE_TEXT],
        adapter => crate::ElementState {
            role: "textfield".into(),
            states: Vec::new(),
            value: Some(adapter.value.lock().unwrap().clone()),
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }
    );
}

impl ActionOps for StaleThenOkAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        lease.deadline().ensure_remaining()?;
        self.policies.lock().unwrap().push(request.policy);
        self.expected_processes
            .lock()
            .unwrap()
            .push(request.expected_process().is_some());
        if let crate::Action::TypeText(text) = request.action {
            self.value.lock().unwrap().push_str(&text);
        }
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl InputOps for StaleThenOkAdapter {}
impl SystemOps for StaleThenOkAdapter {
    crate::adapter::guarded_interaction_lease!();
    crate::adapter::exact_window_focus!();
}

fn snapshot_id() -> String {
    save_one_ref_snapshot("textfield", "SetValue")
}

/// Regression for the F2 fix: before it, `type_text::execute` always built its
/// `RefArgs` with `timeout_ms: None`, so a caller-supplied `--timeout-ms`
/// budget was silently dropped and the command never retried a transient
/// `STALE_REF`. This proves the CLI-supplied budget is actually wired through
/// by observing a real retry-then-succeed round trip via `execute()`.
#[test]
fn transient_stale_ref_retries_then_succeeds_when_timeout_wired() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = StaleThenOkAdapter::new(2);

    let value = execute(
        TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            text: "hi".into(),
            timeout_ms: Some(5_000),
            interval_ms: None,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["action"], "type_text");
    assert!(adapter.retry.calls() >= 3);
}

#[test]
fn timeout_none_makes_exactly_one_resolve_attempt() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = StaleThenOkAdapter::new(1);

    let err = execute(
        TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            text: "hi".into(),
            timeout_ms: None,
            interval_ms: None,
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "STALE_REF");
    assert_eq!(adapter.retry.calls(), 1);
}

#[test]
fn default_budget_grows_with_the_payload() {
    assert_eq!(default_timeout_ms(""), 5_000);
    assert_eq!(default_timeout_ms("abc"), 5_090);
    assert_eq!(default_timeout_ms("é你"), 5_060);
    assert_eq!(default_timeout_ms(&"x".repeat(2_000)), 65_000);
}

#[test]
fn an_interval_types_each_keystroke_as_its_own_action_on_a_steady_clock() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = StaleThenOkAdapter::new(0);
    let started = std::time::Instant::now();

    let value = execute(
        TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id),
            text: "abc".into(),
            timeout_ms: None,
            interval_ms: Some(40),
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(*adapter.value.lock().unwrap(), "abc");
    let policies = adapter.policies.lock().unwrap();
    assert_eq!(*policies, vec![crate::InteractionPolicy::headless(); 3]);
    assert_eq!(value["keystrokes"], 3);
    assert_eq!(value["interval_ms"], 40);
    assert!(started.elapsed() >= std::time::Duration::from_millis(80));
}

#[test]
fn an_interval_outside_the_cli_range_is_refused_before_anything_is_typed() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_id();
    let adapter = StaleThenOkAdapter::new(0);

    for interval_ms in [0, 2_001] {
        let error = execute(
            TypeArgs {
                ref_id: format!("@{}:e1", snapshot_id),
                text: "abc".into(),
                timeout_ms: None,
                interval_ms: Some(interval_ms),
            },
            &adapter,
            &CommandContext::default(),
        )
        .unwrap_err();
        assert_eq!(error.code(), "INVALID_ARGS", "{interval_ms}");
    }
    assert!(adapter.value.lock().unwrap().is_empty());
}

/// A text field ref that headed input can target: it names its window.
fn windowed_snapshot_id() -> String {
    let bounds = crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    let mut entry = crate::adapter::minimal_ref_entry("textfield", Some("Target"));
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();
    entry.capabilities.available_actions = vec!["SetValue".into()];
    entry.source.source_app = Some("Fixture".into());
    entry.source.source_window_id = Some("w-42".into());
    entry.source.source_window_title = Some("Fixture".into());
    let mut refmap = crate::refs::RefMap::new();
    refmap.allocate(entry);
    crate::refs::refs_store::RefStore::new()
        .unwrap()
        .save_new_snapshot(&refmap)
        .unwrap()
}

fn type_paced(adapter: &StaleThenOkAdapter, text: &str, context: &CommandContext) -> Value {
    execute(
        TypeArgs {
            ref_id: format!("@{}:e1", windowed_snapshot_id()),
            text: text.into(),
            timeout_ms: None,
            interval_ms: Some(30),
        },
        adapter,
        context,
    )
    .unwrap()
}

#[test]
fn a_headed_interval_resolves_the_field_once_then_posts_each_keystroke_to_it() {
    let _guard = HomeGuard::new();
    let headed = CommandContext::default().with_headed(true);
    let single = StaleThenOkAdapter::new(0);
    type_paced(&single, "a", &headed);
    let burst = StaleThenOkAdapter::new(0);
    let started = std::time::Instant::now();

    let value = type_paced(&burst, "abcd", &headed);

    assert_eq!(*burst.value.lock().unwrap(), "abcd");
    assert_eq!(
        *burst.policies.lock().unwrap(),
        vec![crate::InteractionPolicy::headed(); 4]
    );
    assert_eq!(
        burst.retry.calls(),
        single.retry.calls() + 1,
        "only the first keystroke runs the full ref action; the burst resolves once more"
    );
    assert_eq!(
        *burst.expected_processes.lock().unwrap(),
        vec![true; 4],
        "every keystroke names the process it must reach"
    );
    assert_eq!(value["keystrokes"], 4);
    assert!(started.elapsed() >= std::time::Duration::from_millis(90));
}

#[test]
fn a_zero_timeout_with_an_interval_tries_each_keystroke_once_instead_of_failing() {
    let _guard = HomeGuard::new();
    let adapter = StaleThenOkAdapter::new(0);

    let value = execute(
        TypeArgs {
            ref_id: format!("@{}:e1", snapshot_id()),
            text: "abc".into(),
            timeout_ms: Some(0),
            interval_ms: Some(20),
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(*adapter.value.lock().unwrap(), "abc");
    assert_eq!(value["keystrokes"], 3);
}
