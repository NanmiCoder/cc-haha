use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

struct LeaseFlag(Arc<AtomicBool>);

impl Drop for LeaseFlag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct RendererAdapter {
    lease_held: Arc<AtomicBool>,
    observations: AtomicU32,
    activations: AtomicU32,
}

impl ObservationOps for RendererAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, crate::AdapterError> {
        let attempt = self.observations.fetch_add(1, Ordering::SeqCst);
        if attempt == 0 {
            return Err(
                crate::AdapterError::renderer_accessibility_activation_required(
                    "activation required",
                ),
            );
        }
        assert!(!self.lease_held.load(Ordering::SeqCst));
        crate::adapter::observed_tree(
            &root,
            crate::AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: Default::default(),
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: Vec::new(),
            },
        )
    }
}

impl ActionOps for RendererAdapter {}
impl InputOps for RendererAdapter {}

impl SystemOps for RendererAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, crate::AdapterError> {
        self.lease_held.store(true, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, LeaseFlag(Arc::clone(&self.lease_held)))
    }

    fn activate_renderer_accessibility(
        &self,
        _process: crate::ProcessIdentity,
        _lease: &crate::InteractionLease,
    ) -> Result<(), crate::AdapterError> {
        assert!(self.lease_held.load(Ordering::SeqCst));
        self.activations.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn activation_lease_is_dropped_before_observation_retry() {
    let held = Arc::new(AtomicBool::new(false));
    let adapter = RendererAdapter {
        lease_held: Arc::clone(&held),
        observations: AtomicU32::new(0),
        activations: AtomicU32::new(0),
    };
    let window = crate::WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("instance-1".into()),
        bounds: None,
        state: Default::default(),
    };
    let deadline = crate::Deadline::after(5_000).unwrap();
    let request = ObservationRequest::snapshot(&crate::TreeOptions::default(), deadline)
        .validate()
        .unwrap();

    observe_tree(&adapter, ObservationRoot::Window(&window), &request).unwrap();

    assert_eq!(adapter.observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.activations.load(Ordering::SeqCst), 1);
    assert!(!held.load(Ordering::SeqCst));
}

struct NeverActivatesAdapter {
    lease_held: Arc<AtomicBool>,
    observations: AtomicU32,
}

impl ObservationOps for NeverActivatesAdapter {
    fn observe_tree(
        &self,
        _root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, crate::AdapterError> {
        self.observations.fetch_add(1, Ordering::SeqCst);
        Err(crate::AdapterError::renderer_accessibility_activation_required("activation required"))
    }
}

impl ActionOps for NeverActivatesAdapter {}
impl InputOps for NeverActivatesAdapter {}

impl SystemOps for NeverActivatesAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, crate::AdapterError> {
        self.lease_held.store(true, Ordering::SeqCst);
        crate::InteractionLease::guarded(deadline, LeaseFlag(Arc::clone(&self.lease_held)))
    }

    fn activate_renderer_accessibility(
        &self,
        _process: crate::ProcessIdentity,
        _lease: &crate::InteractionLease,
    ) -> Result<(), crate::AdapterError> {
        Ok(())
    }
}

#[test]
fn a_renderer_that_never_activates_is_not_re_walked_continuously() {
    let held = Arc::new(AtomicBool::new(false));
    let adapter = NeverActivatesAdapter {
        lease_held: Arc::clone(&held),
        observations: AtomicU32::new(0),
    };
    let window = crate::WindowInfo {
        id: "w-1".into(),
        title: "Renderer".into(),
        app: "Renderer".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("instance-1".into()),
        bounds: None,
        state: Default::default(),
    };
    let deadline = crate::Deadline::after(3_000).unwrap();
    let request = ObservationRequest::snapshot(&crate::TreeOptions::default(), deadline)
        .validate()
        .unwrap();

    observe_tree(&adapter, ObservationRoot::Window(&window), &request)
        .expect_err("a renderer that never activates must still fail at the deadline");

    let attempts = adapter.observations.load(Ordering::SeqCst);
    assert!(
        attempts <= 16,
        "each retry costs a full tree walk; a 3s budget polled without backoff would spend \
         over a hundred of them, got {attempts}"
    );
}

struct SwitchAdapter {
    needs: std::time::Duration,
    takes: std::time::Duration,
    switched: AtomicBool,
    offered_ms: std::sync::atomic::AtomicU64,
    walks: std::sync::Mutex<Vec<Walk>>,
}

struct Walk {
    expires_no_earlier_than: std::time::Instant,
    expires_no_later_than: std::time::Instant,
    remaining: std::time::Duration,
    timeout_ms: u64,
}

impl ObservationOps for SwitchAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, crate::AdapterError> {
        let before = std::time::Instant::now();
        let remaining = request.deadline.remaining();
        let after = std::time::Instant::now();
        let mut walks = self.walks.lock().unwrap();
        walks.push(Walk {
            expires_no_earlier_than: before + remaining,
            expires_no_later_than: after + remaining,
            remaining,
            timeout_ms: request.deadline.timeout_ms(),
        });
        if walks.len() == 1 {
            return Err(
                crate::AdapterError::renderer_accessibility_activation_required(
                    "activation required",
                ),
            );
        }
        crate::adapter::observed_tree(
            &root,
            crate::AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: Default::default(),
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: Vec::new(),
            },
        )
    }
}

impl ActionOps for SwitchAdapter {}
impl InputOps for SwitchAdapter {}

impl SystemOps for SwitchAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::InteractionLease, crate::AdapterError> {
        crate::InteractionLease::guarded(deadline, ())
    }

    fn activate_renderer_accessibility(
        &self,
        _process: crate::ProcessIdentity,
        lease: &crate::InteractionLease,
    ) -> Result<(), crate::AdapterError> {
        self.offered_ms
            .store(lease.deadline().remaining_ms(), Ordering::SeqCst);
        if lease.deadline().remaining() <= self.needs {
            return Err(lease.deadline().timeout_error());
        }
        std::thread::sleep(self.takes);
        self.switched.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn switch(needs_ms: u64, takes_ms: u64) -> SwitchAdapter {
    SwitchAdapter {
        needs: std::time::Duration::from_millis(needs_ms),
        takes: std::time::Duration::from_millis(takes_ms),
        switched: AtomicBool::new(false),
        offered_ms: std::sync::atomic::AtomicU64::new(0),
        walks: std::sync::Mutex::new(Vec::new()),
    }
}

fn renderer_window() -> crate::WindowInfo {
    crate::WindowInfo {
        id: "w-1".into(),
        title: "Renderer".into(),
        app: "Renderer".into(),
        pid: crate::ProcessId::new(42),
        process_instance: Some("instance-1".into()),
        bounds: None,
        state: Default::default(),
    }
}

fn snapshot_request(deadline: crate::Deadline) -> ObservationRequest {
    ObservationRequest::snapshot(&crate::TreeOptions::default(), deadline)
        .validate()
        .unwrap()
}

#[test]
fn time_spent_switching_is_given_back_to_the_observation() {
    let adapter = switch(0, 300);
    let window = renderer_window();
    let request = snapshot_request(crate::Deadline::after(60_000).unwrap());

    observe_tree(&adapter, ObservationRoot::Window(&window), &request)
        .expect("the walk after the switch has the budget the first walk left");

    let walks = adapter.walks.lock().unwrap();
    let given_back = walks[1]
        .expires_no_later_than
        .duration_since(walks[0].expires_no_earlier_than);
    assert!(
        given_back >= adapter.takes,
        "the switch took {:?} and the observation was given back {given_back:?}",
        adapter.takes
    );
    assert_eq!(
        walks[1].timeout_ms, 60_000,
        "the resumed deadline still describes the operation it belongs to"
    );
    assert!(
        adapter.offered_ms.load(Ordering::SeqCst) <= crate::DEFAULT_OPERATION_TIMEOUT_MS,
        "a long operation does not lend the switch its whole timeout"
    );
}

#[test]
fn a_spent_observation_still_switches_so_the_next_one_is_ready() {
    let adapter = switch(1_000, 0);
    let window = renderer_window();
    let spent = crate::Deadline::after(500)
        .unwrap()
        .capped(std::time::Duration::ZERO);

    let error = observe_tree(
        &adapter,
        ObservationRoot::Window(&window),
        &snapshot_request(spent),
    )
    .expect_err("an observation with nothing left does not walk again");

    assert!(matches!(
        error,
        AppError::Adapter(ref adapter_error) if adapter_error.code == crate::ErrorCode::Timeout
    ));
    assert!(
        adapter.switched.load(Ordering::SeqCst),
        "the switch needs 1000ms and was offered {}ms, so it would be refused every time",
        adapter.offered_ms.load(Ordering::SeqCst)
    );
    assert_eq!(adapter.walks.lock().unwrap().len(), 1);
}

#[test]
fn a_refused_switch_reports_the_operation_budget_and_is_not_retried() {
    let adapter = switch(10_000, 0);
    let window = renderer_window();
    let request = snapshot_request(crate::Deadline::after(3_000).unwrap());

    let error = observe_tree(&adapter, ObservationRoot::Window(&window), &request)
        .expect_err("a switch that cannot run fails the observation");

    let AppError::Adapter(error) = error else {
        panic!("expected an adapter error");
    };
    assert_eq!(error.code, crate::ErrorCode::Timeout);
    let details = error.details.expect("a timeout describes its deadline");
    assert_eq!(details["timeout_ms"], 3_000);
    assert!(!adapter.switched.load(Ordering::SeqCst));
    assert_eq!(adapter.walks.lock().unwrap().len(), 1);
}

#[test]
fn the_credit_for_switch_time_stays_inside_an_inherited_deadline() {
    let _clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = switch(0, 300);
    let window = renderer_window();
    let request = snapshot_request(crate::Deadline::after(60_000).unwrap());
    let parent = crate::Deadline::detached_after(1_000).unwrap();
    let _scope = crate::wait::deadline::enter_scope(Some(parent));

    observe_tree(&adapter, ObservationRoot::Window(&window), &request)
        .expect("the walk after the switch still fits the inherited deadline");

    let walks = adapter.walks.lock().unwrap();
    assert_eq!(
        walks[1].remaining,
        parent.remaining(),
        "the resumed walk outlives the deadline the command inherited"
    );
}
