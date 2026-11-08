use super::test_support::window;
use super::{
    LocatorMaterialization, LocatorResolveRequest, LocatorSelection, ObservationRequest,
    ObservationRoot, ObservedTree, resolve_query,
};
use crate::{
    AdapterError, DeliverySemantics, ErrorCode,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
    locator::LocatorQuery,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct HydrationRetryAdapter {
    window_observations: AtomicUsize,
    hydration_observations: AtomicUsize,
}

impl ObservationOps for HydrationRetryAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        match root {
            ObservationRoot::Window(_) => {
                self.window_observations.fetch_add(1, Ordering::SeqCst);
                Ok(lean_button_tree())
            }
            ObservationRoot::Element { .. } => {
                let attempt = self.hydration_observations.fetch_add(1, Ordering::SeqCst);
                if attempt == 0 {
                    return Err(AdapterError::new(ErrorCode::StaleRef, "hydration retry")
                        .with_suggestion(
                            "Run 'snapshot' to refresh, then retry with the updated ref.",
                        )
                        .with_disposition(DeliverySemantics::not_delivered())
                        .with_details(serde_json::json!({ "retryable": true })));
                }
                Ok(button_tree())
            }
        }
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<crate::NativeHandle, AdapterError> {
        Ok(crate::NativeHandle::null())
    }
}

impl ActionOps for HydrationRetryAdapter {}
impl InputOps for HydrationRetryAdapter {}
impl SystemOps for HydrationRetryAdapter {}

fn button_tree() -> ObservedTree {
    super::test_support::tree(
        vec![super::test_support::node(
            0,
            super::test_support::evidence("button", Some("Save")),
            Vec::new(),
            &[],
        )],
        vec![0],
        true,
    )
}

fn lean_button_tree() -> ObservedTree {
    let mut evidence = super::test_support::evidence("button", Some("Save"));
    evidence.description = super::LocatorField::Unknown;
    super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    )
}

struct CountingAdapter {
    element_observations: AtomicUsize,
}

impl ObservationOps for CountingAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if matches!(root, ObservationRoot::Element { .. }) {
            self.element_observations.fetch_add(1, Ordering::SeqCst);
        }
        Ok(button_tree())
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<crate::NativeHandle, AdapterError> {
        self.element_observations.fetch_add(1, Ordering::SeqCst);
        Ok(crate::NativeHandle::null())
    }
}

impl ActionOps for CountingAdapter {}
impl InputOps for CountingAdapter {}
impl SystemOps for CountingAdapter {}

#[test]
fn a_match_the_walk_read_in_full_is_not_read_again() {
    let adapter = CountingAdapter {
        element_observations: AtomicUsize::new(0),
    };
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 10,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    };

    let resolution = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request,
    )
    .unwrap();

    assert_eq!(adapter.element_observations.load(Ordering::SeqCst), 0);
    assert_eq!(resolution.matches[0].data.name, "Save");
    assert!(resolution.refmap.is_some());
}

#[test]
fn hydration_retry_preserves_failed_attempt_statistics() {
    let adapter = HydrationRetryAdapter {
        window_observations: AtomicUsize::new(0),
        hydration_observations: AtomicUsize::new(0),
    };
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 10,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    };

    let resolution = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request,
    )
    .unwrap();

    assert_eq!(adapter.window_observations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.hydration_observations.load(Ordering::SeqCst), 2);
    assert_eq!(resolution.stats.reads.counts.observation_attempts, 3);
}

struct IncompleteHydrationAdapter {
    hydration_observations: AtomicUsize,
}

impl ObservationOps for IncompleteHydrationAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if matches!(root, ObservationRoot::Window(_)) {
            return Ok(lean_button_tree());
        }
        self.hydration_observations.fetch_add(1, Ordering::SeqCst);
        let mut evidence = super::test_support::evidence("button", Some("Save"));
        evidence.ref_evidence.bounds = super::LocatorField::Unknown;
        Ok(super::test_support::tree(
            vec![super::test_support::node(0, evidence, Vec::new(), &[])],
            vec![0],
            true,
        ))
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<crate::NativeHandle, AdapterError> {
        Ok(crate::NativeHandle::null())
    }
}

impl ActionOps for IncompleteHydrationAdapter {}
impl InputOps for IncompleteHydrationAdapter {}
impl SystemOps for IncompleteHydrationAdapter {}

#[test]
fn selected_hydration_rejects_incomplete_snapshot_evidence() {
    let adapter = IncompleteHydrationAdapter {
        hydration_observations: AtomicUsize::new(0),
    };
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::after(35).unwrap(),
        max_raw_depth: 10,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    };

    let error = match resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&window()),
        &request,
    ) {
        Ok(_) => panic!("incomplete hydration unexpectedly succeeded"),
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::Timeout.as_str());
    assert!(adapter.hydration_observations.load(Ordering::SeqCst) >= 1);
}

fn framed_rect(x: f64, y: f64) -> crate::Rect {
    crate::Rect {
        x,
        y,
        width: 177.0,
        height: 18.0,
    }
}

fn framed_label_tree(screen: Option<crate::Rect>, lean: bool) -> ObservedTree {
    let mut evidence = super::test_support::evidence("statictext", Some("Frame label"));
    evidence.ref_evidence.window_bounds = super::LocatorField::Known(framed_rect(48.0, 70.0));
    evidence.ref_evidence.bounds = screen.map_or(super::LocatorField::Absent, |rect| {
        super::LocatorField::Known(rect)
    });
    if lean {
        evidence.description = super::LocatorField::Unknown;
    }
    super::test_support::tree(
        vec![super::test_support::node(0, evidence, Vec::new(), &[])],
        vec![0],
        true,
    )
}

struct ReadAgainAdapter {
    first_screen: crate::Rect,
    again_screen: Option<crate::Rect>,
}

impl ObservationOps for ReadAgainAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        Ok(match root {
            ObservationRoot::Window(_) => framed_label_tree(Some(self.first_screen), true),
            ObservationRoot::Element { .. } => framed_label_tree(self.again_screen, false),
        })
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<crate::NativeHandle, AdapterError> {
        Ok(crate::NativeHandle::null())
    }
}

impl ActionOps for ReadAgainAdapter {}
impl InputOps for ReadAgainAdapter {}
impl SystemOps for ReadAgainAdapter {}

#[test]
fn a_hydrated_match_shows_the_screen_rectangle_the_re_read_found_or_else_the_first_one() {
    let first = framed_rect(214.0, 202.0);
    let moved = framed_rect(300.0, 250.0);
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::after(5_000).unwrap(),
        max_raw_depth: 10,
        surface: None,
        materialization: LocatorMaterialization::SelectedMatches,
    };
    for (again, shown) in [(Some(moved), moved), (None, first)] {
        let adapter = ReadAgainAdapter {
            first_screen: first,
            again_screen: again,
        };

        let resolution = resolve_query(
            &adapter,
            &LocatorQuery::default(),
            ObservationRoot::Window(&window()),
            &request,
        )
        .unwrap();

        let matched = &resolution.matches[0];
        assert_eq!(matched.screen_bounds, Some(shown));
        assert_eq!(matched.entry.geometry.bounds, Some(framed_rect(48.0, 70.0)));
        assert_eq!(
            matched.entry.geometry.bounds_space,
            Some(crate::BoundsSpace::Window)
        );
    }
}
