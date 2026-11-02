use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

struct DoubleCheckAdapter {
    live_calls: AtomicU32,
    bounds_reads: AtomicU32,
    lease_held: Arc<AtomicBool>,
    prelease_calls: u32,
    timeout_ms: u64,
    expected_deadline: Option<crate::Deadline>,
    available_action: &'static str,
}

struct DoubleCheckLeaseGuard(Arc<AtomicBool>);

impl Drop for DoubleCheckLeaseGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ObservationOps for DoubleCheckAdapter {
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
    ) -> Result<crate::adapter::LiveElement, AdapterError> {
        let call = self.live_calls.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(
            self.lease_held.load(Ordering::SeqCst),
            call > self.prelease_calls,
            "poll reads must be lease-free and final validation must be leased"
        );
        let states = if call <= self.prelease_calls {
            Vec::new()
        } else {
            vec!["disabled".to_string()]
        };
        Ok(crate::adapter::LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: crate::tree::element_state::ElementState {
                role: "button".into(),
                states,
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(bounds()),
            available_actions: vec![self.available_action.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        self.bounds_reads.fetch_add(1, Ordering::SeqCst);
        Ok(Some(bounds()))
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

impl ActionOps for DoubleCheckAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::actions::action_result::ActionResult, AdapterError> {
        Ok(crate::actions::action_result::ActionResult::delivered_unverified("click"))
    }
}

impl InputOps for DoubleCheckAdapter {}

impl SystemOps for DoubleCheckAdapter {
    crate::adapter::exact_window_focus!();

    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        assert_eq!(self.live_calls.load(Ordering::SeqCst), self.prelease_calls);
        assert_eq!(deadline.timeout_ms(), self.timeout_ms);
        if let Some(expected) = self.expected_deadline {
            assert_eq!(deadline, expected);
            return Err(AdapterError::new(ErrorCode::Internal, "lease probe"));
        }
        self.lease_held.store(true, Ordering::SeqCst);
        Ok(crate::InteractionLease::guarded_with_contention(
            deadline,
            DoubleCheckLeaseGuard(Arc::clone(&self.lease_held)),
            3,
        ))
    }
}

/// Exactly one post-lease live read: this mock's bounds/hash never change,
/// so the permissive stability check that read establishes already passes -
/// `stable_preflight`'s settle-and-resample loop (`ref_action.rs`) exists
/// for a report whose only gap is `stable`, and short-circuits immediately
/// once the first live read already confirms it, rather than resampling a
/// target that was never unstable.
#[test]
fn stability_revalidates_once_under_lease_before_dispatch() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = adapter(2, 5_000, None);
    let result = run_with_entry(
        &adapter,
        ActionRequest::headed(Action::DoubleClick),
        5_000,
        &entry(),
    );

    assert_eq!(result.action, "click");
    assert_eq!(adapter.live_calls.load(Ordering::SeqCst), 3);
    let metrics = &result.details.as_ref().unwrap()["auto_wait"];
    assert_eq!(metrics["read_only_resolve_attempts"], 2);
    assert_eq!(metrics["read_only_preflight_attempts"], 2);
    assert_eq!(metrics["lease_contention_count"], 3);
    assert!(metrics["lease_hold_ms"].as_u64().is_some());
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
}

fn entry_with_mismatched_bounds_hash() -> RefEntry {
    let mut stale = entry();
    stale.geometry.bounds_hash = crate::Rect {
        x: 400.0,
        y: 400.0,
        width: 10.0,
        height: 10.0,
    }
    .bounds_hash();
    stale
}

/// A live element whose bounds and identity are otherwise fine, but whose
/// ref carries a `bounds_hash` from a different position - the exact shape
/// a caller's own preceding `scroll-to` on the same ref leaves behind
/// (measured live: -171 -> 181 on the Windows fixture, `A24-18`).
///
/// Before this fix, `stable_preflight`'s permissive check propagated this
/// mismatch as a terminal `ACTION_FAILED` via the `?` in `ref_action.rs`
/// before the settle-and-resample loop beneath it could ever run - proven
/// by reverting the discriminator and watching this test fail closed.
#[test]
fn a_stability_only_mismatch_settles_and_proceeds_to_dispatch() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = adapter(2, 5_000, None);
    let result = run_with_entry(
        &adapter,
        ActionRequest::headed(Action::DoubleClick),
        5_000,
        &entry_with_mismatched_bounds_hash(),
    );

    assert_eq!(result.action, "click");
    assert!(adapter.bounds_reads.load(Ordering::SeqCst) >= 3);
}

/// A headless pointerless action whose live bounds match the snapshot needs
/// one lease-free read, not a second observation to seed the comparison:
/// the leased read still validates it, exactly as for a semantic click.
#[test]
fn a_matching_snapshot_hash_settles_a_headless_pointerless_action_in_one_read() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let mut adapter = adapter(1, 5_000, None);
    adapter.available_action = capability::SCROLL;
    let result = run_with_entry(
        &adapter,
        ActionRequest::headless(Action::Scroll(crate::Direction::Down, 1)),
        5_000,
        &entry(),
    );

    assert_eq!(adapter.live_calls.load(Ordering::SeqCst), 2);
    let metrics = &result.details.as_ref().unwrap()["auto_wait"];
    assert_eq!(metrics["read_only_preflight_attempts"], 1);
}

struct DisabledAfterLeaseAdapter {
    calls: AtomicU32,
    prelease_calls: u32,
    bounds_calls: AtomicU32,
}

impl ObservationOps for DisabledAfterLeaseAdapter {
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
    ) -> Result<crate::adapter::LiveElement, AdapterError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(crate::adapter::LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: crate::tree::element_state::ElementState {
                role: "button".into(),
                states: vec![],
                value: None,
                enabled: Some(call <= self.prelease_calls),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: Some(bounds()),
            available_actions: vec![capability::CLICK.into()],
        })
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        self.bounds_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(bounds()))
    }
}

impl ActionOps for DisabledAfterLeaseAdapter {}
impl InputOps for DisabledAfterLeaseAdapter {}
impl SystemOps for DisabledAfterLeaseAdapter {
    crate::adapter::exact_window_focus!();

    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, AdapterError> {
        Ok(crate::InteractionLease::guarded_with_contention(
            deadline,
            DoubleCheckLeaseGuard(Arc::new(AtomicBool::new(false))),
            0,
        ))
    }
}

/// A stale bounds hash alongside a genuinely disabled element must not
/// enter the settle-and-resample loop: no amount of waiting enables a
/// disabled control, so the fix's discriminator - "stable" is the *only*
/// unmet requirement - must see "enabled" also fail and propagate
/// immediately, the same as before this fix existed. The element is
/// enabled for the pre-lease polling reads and only goes disabled once
/// `stable_preflight` reads it under lease, so this pins the post-lease
/// discriminator specifically rather than the separate pre-lease poll.
#[test]
fn a_disabled_element_fails_closed_without_sampling_even_with_a_stale_hash() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = DisabledAfterLeaseAdapter {
        calls: AtomicU32::new(0),
        prelease_calls: 2,
        bounds_calls: AtomicU32::new(0),
    };
    let error = execute_with_auto_wait(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry_with_mismatched_bounds_hash(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headed(Action::DoubleClick).with_timeout_ms(Some(5_000)),
        crate::ref_action::dispatch_resolved,
    )
    .err()
    .unwrap();

    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(adapter.bounds_calls.load(Ordering::SeqCst), 0);
}

fn run_with_entry(
    adapter: &DoubleCheckAdapter,
    request: ActionRequest,
    timeout_ms: u64,
    entry: &RefEntry,
) -> crate::actions::action_result::ActionResult {
    execute_with_auto_wait(
        RefActionWaitCtx {
            adapter,
            entry,
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        request.with_timeout_ms(Some(timeout_ms)),
        crate::ref_action::dispatch_resolved,
    )
    .unwrap()
}

#[test]
fn lease_acquisition_receives_the_exact_original_deadline() {
    let deadline = crate::Deadline::after(80).unwrap();
    let adapter = adapter(0, 80, Some(deadline));
    let error = super::super::execute_with_deadline(
        RefActionWaitCtx {
            adapter: &adapter,
            entry: &entry(),
            ref_id: "@e1",
            context: &CommandContext::default(),
        },
        ActionRequest::headless(Action::Click),
        deadline,
        crate::ref_action::dispatch_resolved,
    )
    .err()
    .unwrap();

    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.message, "lease probe");
    assert_eq!(adapter.live_calls.load(Ordering::SeqCst), 0);
    assert!(!adapter.lease_held.load(Ordering::SeqCst));
}

fn adapter(
    prelease_calls: u32,
    timeout_ms: u64,
    expected_deadline: Option<crate::Deadline>,
) -> DoubleCheckAdapter {
    DoubleCheckAdapter {
        live_calls: AtomicU32::new(0),
        bounds_reads: AtomicU32::new(0),
        lease_held: Arc::new(AtomicBool::new(false)),
        prelease_calls,
        timeout_ms,
        expected_deadline,
        available_action: capability::CLICK,
    }
}

fn bounds() -> crate::Rect {
    crate::Rect {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    }
}
