use super::test_support::{
    PredicateAdapter, save_ref_in_session, snapshot_with_one_ref, wait_for_element_test,
};
use super::*;
use crate::adapter::NoopAdapter;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, adapter::NativeHandle, commands::wait_predicate, refs::RefEntry,
    refs::refs_test_support::HomeGuard, tree::element_state::ElementState,
};
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};

struct LiveErrorPredicateAdapter {
    drops: Arc<AtomicU32>,
}

struct DropProbe(Arc<AtomicU32>);

impl Drop for DropProbe {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl ObservationOps for LiveErrorPredicateAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::new(DropProbe(Arc::clone(&self.drops))))
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Err(AdapterError::permission_denied())
    }
}

impl ActionOps for LiveErrorPredicateAdapter {}

impl InputOps for LiveErrorPredicateAdapter {}

impl SystemOps for LiveErrorPredicateAdapter {}

#[test]
fn snapshot_pinned_missing_ref_matches_get_recovery() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();

    let err = wait_for_element_test(
        "@e2".into(),
        Some(snapshot_id.clone()),
        wait_predicate::ElementPredicate::Exists,
        1,
        &NoopAdapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    let get_error = crate::commands::get::execute(
        crate::commands::get::GetArgs {
            ref_id: format!("@{}:e2", snapshot_id),
            property: crate::commands::get::GetProperty::Value,
        },
        &NoopAdapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), get_error.code());
    assert_eq!(err.code(), "STALE_REF");
    assert!(err.suggestion().is_some());
}

struct LateObservationAdapter {
    delay_resolution: bool,
    reads: AtomicU32,
}

impl ObservationOps for LateObservationAdapter {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        if self.delay_resolution {
            while !deadline.is_expired() {
                std::thread::sleep(deadline.remaining());
            }
        }
        Ok(NativeHandle::null())
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        while !deadline.is_expired() {
            std::thread::sleep(deadline.remaining());
        }
        Ok(Some("ready".into()))
    }
}

impl ActionOps for LateObservationAdapter {}
impl InputOps for LateObservationAdapter {}
impl SystemOps for LateObservationAdapter {}

#[test]
fn element_wait_rejects_late_resolution_and_late_matching_value() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    for delay_resolution in [true, false] {
        let adapter = LateObservationAdapter {
            delay_resolution,
            reads: AtomicU32::new(0),
        };
        let predicate = if delay_resolution {
            wait_predicate::ElementPredicate::Exists
        } else {
            wait_predicate::ElementPredicate::Value("ready".into())
        };
        let error = wait_for_element_test(
            "@e1".into(),
            Some(snapshot_id.clone()),
            predicate,
            500,
            &adapter,
            &crate::context::CommandContext::default(),
        )
        .expect_err("late observations cannot satisfy a bounded wait");
        assert_eq!(error.code(), "TIMEOUT");
        assert_eq!(
            adapter.reads.load(Ordering::SeqCst),
            u32::from(!delay_resolution)
        );
    }
}

#[test]
fn element_wait_explicit_session_snapshot_with_matching_session_context() {
    let _guard = HomeGuard::new();
    let snapshot_id = save_ref_in_session("agent-a", Vec::new());
    let adapter = PredicateAdapter {
        state: Some(ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }),
        value: None,
        bounds: None,
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        50,
        &adapter,
        &crate::context::CommandContext::new(Some("agent-a".into()), None, false).unwrap(),
    )
    .unwrap();

    assert_eq!(value["found"], true);
    assert_eq!(value["predicate"], "exists");
}

#[test]
fn element_wait_propagates_live_read_errors_after_dropping_handle() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = LiveErrorPredicateAdapter {
        drops: Arc::new(AtomicU32::new(0)),
    };

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Enabled,
        250,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "PERM_DENIED");
    assert_eq!(adapter.drops.load(Ordering::SeqCst), 1);
}

struct DeadlineTimeoutPredicateAdapter {
    polls: Arc<AtomicU32>,
}

impl ObservationOps for DeadlineTimeoutPredicateAdapter {
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
        deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Err(deadline.timeout_error())
    }
}

impl ActionOps for DeadlineTimeoutPredicateAdapter {}
impl InputOps for DeadlineTimeoutPredicateAdapter {}
impl SystemOps for DeadlineTimeoutPredicateAdapter {}

#[test]
fn element_wait_wraps_bare_live_read_timeout_in_the_documented_wait_timeout() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = DeadlineTimeoutPredicateAdapter {
        polls: Arc::new(AtomicU32::new(0)),
    };

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id.clone()),
        wait_predicate::ElementPredicate::Enabled,
        400,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    assert!(adapter.polls.load(Ordering::SeqCst) > 1);

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected adapter error");
    };
    let details = adapter_err
        .details
        .expect("wait timeout should carry details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["ref"], format!("@{snapshot_id}:e1"));
    assert_eq!(details["predicate"], "enabled");
    assert_eq!(details["timeout_ms"], 400);
    assert_eq!(details["last_observed"]["error"], "TIMEOUT");
    assert_eq!(details["last_observed"]["details"]["kind"], "deadline");
}

#[test]
fn zero_timeout_returns_timeout_before_any_resolution_attempt() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Exists,
        0,
        &NoopAdapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    let AppError::Adapter(adapter_err) = err else {
        panic!("expected adapter error");
    };
    assert_eq!(adapter_err.code, crate::ErrorCode::Timeout);
    let details = adapter_err.details.expect("timeout should carry details");
    assert!(details["last_observed"].is_null());
}
