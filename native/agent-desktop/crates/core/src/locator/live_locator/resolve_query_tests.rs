use super::test_support::window;
use super::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, LocatorStats,
    ObservationRequest, ObservationRoot, ObservedTree, resolve_query,
};
use crate::{
    AdapterError, AppError, ErrorCode,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
    locator::{LocatorQuery, StatePredicate},
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingAdapter {
    builds: AtomicUsize,
    observe: Option<fn(usize) -> ObservedTree>,
}

impl ObservationOps for CountingAdapter {
    fn observe_tree(
        &self,
        _root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        let attempt = self.builds.fetch_add(1, Ordering::SeqCst);
        self.observe
            .map(|observe| observe(attempt))
            .ok_or_else(|| AdapterError::not_supported("fixture locator tree"))
    }
}

impl ActionOps for CountingAdapter {}
impl InputOps for CountingAdapter {}
impl SystemOps for CountingAdapter {}

fn request() -> LocatorResolveRequest {
    request_with_timeout(std::time::Duration::from_secs(5))
}

fn request_with_timeout(timeout: std::time::Duration) -> LocatorResolveRequest {
    LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::from_duration(timeout).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::None,
    }
}

fn observed_tree(complete: bool, stats: LocatorStats) -> ObservedTree {
    let root = super::test_support::node(
        0,
        super::test_support::evidence("window", Some("Fixture")),
        Vec::new(),
        &[],
    );
    let mut tree = super::test_support::tree(vec![root], vec![0], complete);
    tree.stats = stats;
    tree
}

fn churn_then_stable(attempt: usize) -> ObservedTree {
    let mut stats = LocatorStats::default();
    if attempt == 0 {
        stats.traversal.limits.child_count_changes = 1;
        observed_tree(false, stats)
    } else {
        observed_tree(true, stats)
    }
}

fn always_cannot_complete(_: usize) -> ObservedTree {
    let mut stats = LocatorStats::default();
    stats.reads.health.cannot_complete = 1;
    observed_tree(false, stats)
}

fn node_limit(_: usize) -> ObservedTree {
    let mut stats = LocatorStats::default();
    stats.traversal.limits.node_hits = 1;
    observed_tree(false, stats)
}

fn child_label_cap(_: usize) -> ObservedTree {
    let mut stats = LocatorStats::default();
    stats.traversal.limits.child_label_hits = 1;
    observed_tree(true, stats)
}

#[test]
fn resolve_query_validates_before_calling_the_adapter() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: None,
    };
    let query = LocatorQuery {
        states: vec![StatePredicate {
            token: "imaginary".into(),
            expected: None,
        }],
        ..LocatorQuery::default()
    };
    let error = resolve_query(
        &adapter,
        &query,
        ObservationRoot::Window(&window()),
        &request(),
    )
    .err()
    .unwrap();
    assert_eq!(error.code(), ErrorCode::InvalidArgs.as_str());
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 0);
}

#[test]
fn resolve_query_delegates_valid_queries_once() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: None,
    };
    let error = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .err()
    .unwrap();
    assert_eq!(error.code(), ErrorCode::PlatformNotSupported.as_str());
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 1);
}

#[test]
fn child_count_churn_retries_until_the_observation_is_stable() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: Some(churn_then_stable),
    };

    let resolution = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .unwrap();

    assert!(resolution.meta.complete);
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 2);
    assert_eq!(resolution.stats.reads.counts.observation_attempts, 2);
    assert_eq!(resolution.stats.traversal.limits.child_count_changes, 1);
}

#[test]
fn persistent_cannot_complete_exhausts_one_deadline_with_last_evidence() {
    let clock = crate::wait::deadline::VirtualClock::freeze();
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: Some(always_cannot_complete),
    };

    let error = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request_with_timeout(std::time::Duration::from_millis(35)),
    )
    .err()
    .expect("persistent incompleteness must time out");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "locator_transient_incomplete");
    let observation_attempts = details["observation_attempts"].as_u64().unwrap();
    assert_eq!(observation_attempts, 4);
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 4);
    assert_eq!(clock.elapsed(), std::time::Duration::from_millis(35));
    assert_eq!(details["last_incomplete"]["cannot_complete"], 1);
    assert_eq!(
        details["query_stats"]["reads"]["cannot_complete"],
        observation_attempts
    );
}

#[test]
fn child_label_cap_alone_is_not_a_global_budget_failure() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: Some(child_label_cap),
    };

    let resolution = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .expect("a per-node child-label cap must not fail a complete resolution");

    assert_eq!(resolution.stats.traversal.limits.child_label_hits, 1);
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 1);
}

#[test]
fn deterministic_observation_limit_fails_without_retrying() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: Some(node_limit),
    };

    let error = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request(),
    )
    .err()
    .expect("deterministic limits must reject the resolution");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.details.unwrap()["kind"], "locator_budget_limit");
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 1);
}

#[test]
fn strict_unknown_incomplete_result_fails_closed() {
    let adapter = CountingAdapter {
        builds: AtomicUsize::new(0),
        observe: Some(|_| observed_tree(false, LocatorStats::default())),
    };

    let error = match resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request(),
    ) {
        Ok(_) => panic!("strict incomplete result unexpectedly succeeded"),
        Err(error) => error,
    };

    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.details.unwrap()["kind"], "locator_incomplete");
    assert_eq!(adapter.builds.load(Ordering::SeqCst), 1);
}
