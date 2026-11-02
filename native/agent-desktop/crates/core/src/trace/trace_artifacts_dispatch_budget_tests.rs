use super::tests::{MINI_PNG, artifacts_session, entry, setup_artifacts_test};
use crate::context::CommandContext;
use crate::refs::refs_store::RefStore;
use crate::wait::deadline::VirtualClock;
use crate::{
    Action, ActionRequest, ActionResult, AdapterError, ImageBuffer,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, ScreenshotTarget, SystemOps},
};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

const ACTION_BUDGET_MS: u64 = 3_000;
const CAPTURE_LOCK_WAIT_MS: u64 = 50;
const CAPTURES_PER_ACTION: u64 = 2;

struct DeadlineConsumingScreenshotAdapter {
    dispatch_calls: AtomicU32,
    screenshot_calls: AtomicU32,
    dispatch_budget_ms: AtomicU64,
    consume_pre_deadline: bool,
}

impl DeadlineConsumingScreenshotAdapter {
    fn new(consume_pre_deadline: bool) -> Self {
        Self {
            dispatch_calls: AtomicU32::new(0),
            screenshot_calls: AtomicU32::new(0),
            dispatch_budget_ms: AtomicU64::new(0),
            consume_pre_deadline,
        }
    }
}

impl ObservationOps for DeadlineConsumingScreenshotAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    crate::adapter::complete_live_observation!(
        "button",
        "Run",
        [crate::actions::capability::CLICK]
    );
}

impl ActionOps for DeadlineConsumingScreenshotAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        self.dispatch_budget_ms
            .store(request.timeout_ms.unwrap_or_default(), Ordering::SeqCst);
        Ok(ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for DeadlineConsumingScreenshotAdapter {}

impl SystemOps for DeadlineConsumingScreenshotAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn screenshot(
        &self,
        _target: ScreenshotTarget,
        deadline: crate::Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        if self.consume_pre_deadline && self.screenshot_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let delay = if deadline.was_capped() {
                std::time::Duration::from_millis(50)
            } else {
                deadline.remaining()
            };
            std::thread::sleep(delay);
            return Err(deadline.timeout_error());
        }
        Ok(ImageBuffer {
            data: MINI_PNG.to_vec(),
            format: crate::ImageFormat::Png,
            width: 1,
            height: 1,
            scale_factor: 1.0,
        })
    }
}

#[test]
fn slow_pre_capture_preserves_dispatch_budget() {
    let (_home, _lock) = setup_artifacts_test();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id), None, false).unwrap();
    let adapter = DeadlineConsumingScreenshotAdapter::new(true);
    let target = entry(42);

    let result = crate::ref_action::ref_action_wait::execute_with_auto_wait(
        crate::ref_action::ref_action_wait_context::RefActionWaitContext {
            adapter: &adapter,
            entry: &target,
            ref_id: "@e1",
            context: &context,
        },
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(500)),
        crate::ref_action::dispatch_resolved,
    );

    assert!(
        result.is_ok(),
        "slow trace capture blocked dispatch: {result:?}"
    );
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

fn trace_body(trace_dir: &std::path::Path) -> String {
    let mut body = String::new();
    for entry in std::fs::read_dir(trace_dir).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            body.push_str(&std::fs::read_to_string(path).unwrap());
        }
    }
    body
}

/// The artifact lock is held for the whole action, so neither capture can take
/// it. What must survive is the action itself: it dispatches exactly once, the
/// captures record why they were skipped, and the budget the action dispatches
/// with is still the budget it started with less the two bounded capture waits.
/// A wait bounded by the caller's deadline instead would spend the whole
/// budget before dispatch.
#[test]
fn contended_artifact_lock_preserves_dispatch_budget() {
    let (_home, _lock) = setup_artifacts_test();
    let clock = VirtualClock::freeze();
    let manifest = artifacts_session();
    let context = CommandContext::new(Some(manifest.id.clone()), None, false).unwrap();
    let trace_dir = RefStore::for_session(Some(&manifest.id))
        .unwrap()
        .trace_dir();
    std::fs::create_dir_all(&trace_dir).unwrap();
    let lock_path = trace_dir.join(".artifact-budget.lock");
    let _artifact_lock = crate::refs::refs_lock::RefStoreLock::acquire(&lock_path).unwrap();
    assert!(crate::refs::refs_lock::lock_holder_is_live(&lock_path));
    let adapter = DeadlineConsumingScreenshotAdapter::new(false);
    let target = entry(42);

    let result = crate::ref_action::ref_action_wait::execute_with_auto_wait(
        crate::ref_action::ref_action_wait_context::RefActionWaitContext {
            adapter: &adapter,
            entry: &target,
            ref_id: "@e1",
            context: &context,
        },
        ActionRequest::headless(Action::Click).with_timeout_ms(Some(ACTION_BUDGET_MS)),
        crate::ref_action::dispatch_resolved,
    );

    assert!(result.is_ok(), "artifact lock blocked dispatch: {result:?}");
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    let dispatch_budget_ms = adapter.dispatch_budget_ms.load(Ordering::SeqCst);
    assert!(
        dispatch_budget_ms >= ACTION_BUDGET_MS - CAPTURES_PER_ACTION * CAPTURE_LOCK_WAIT_MS,
        "only {dispatch_budget_ms} ms of the action's {ACTION_BUDGET_MS} ms budget survived the contended capture"
    );
    assert_eq!(
        std::fs::read_dir(trace_dir.join("screens"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        trace_body(&trace_dir).contains("\"skipped\":\"lock_failed\""),
        "the skipped capture was not traced with its reason"
    );
    assert!(
        clock.elapsed() <= Duration::from_millis(CAPTURES_PER_ACTION * CAPTURE_LOCK_WAIT_MS),
        "the contended captures delayed the action by {:?}",
        clock.elapsed()
    );
}
