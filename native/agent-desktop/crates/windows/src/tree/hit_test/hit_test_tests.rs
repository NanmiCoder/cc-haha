use super::classify::{
    Ancestry, AncestryWalk, HitClassification, ancestry_with, classify_hit_with, classify_relation,
    remember_ancestor_key, result_for_incomplete_walk, should_demote_outside_viewport,
};
use super::hit_test_impl;
use super::imp::{
    judge_probe, physical_point, pre_read_fate_for_test, resolve_classification, saturate_coord,
};
use crate::system::runtime::hresult::{E_ACCESSDENIED, E_FAIL, UIA_E_NOTSUPPORTED, UIA_E_TIMEOUT};
use crate::tree::automation::{ERR_INVALID_ARG, ERR_TIMEOUT, UiaFailure, root_from_hwnd};
use crate::tree::fixture::{LocalFixture, ensure_test_apartment};
use crate::tree::walk::walker::NodeKey;
use crate::tree::walk::walker_fake::deadline;
use agent_desktop_core::{Deadline, ErrorCode, Point, Rect, adapter::hit_test::HitTestResult};
use std::cell::Cell;
use std::collections::HashMap;

#[test]
fn self_hit_reaches_target() {
    assert_eq!(
        classify_relation(true, false),
        HitClassification::ReachesTarget
    );
}

#[test]
fn descendant_relation_reaches_target() {
    assert_eq!(
        classify_relation(true, true),
        HitClassification::ReachesTarget
    );
}

#[test]
fn ancestor_hit_classifies_unknown_not_intercepted() {
    let classification = classify_relation(false, true);
    assert_eq!(classification, HitClassification::AncestorOfTarget);
    let result = resolve_classification(classification, intercepted_stub);
    assert_eq!(result, HitTestResult::Unknown);
    assert!(
        !matches!(result, HitTestResult::InterceptedBy { .. }),
        "ancestor arm must never invent InterceptedBy"
    );
}

#[test]
fn unrelated_hit_reaches_corroboration_seam() {
    let called = Cell::new(false);
    let result = resolve_classification(HitClassification::Unrelated, || {
        called.set(true);
        HitTestResult::Unknown
    });
    assert!(
        called.get(),
        "unrelated hits must invoke the corroboration seam"
    );
    assert_eq!(result, HitTestResult::Unknown);
}

/// The demotion is a same-root concern, so it is raised *inside* corroboration
/// rather than short-circuiting it: silencing every unrelated hit would lose
/// the cross-window occluder two independent opinions already agreed on.
/// Nothing between the classification and the seam may filter what the seam
/// answers, whatever the flag.
#[test]
fn viewport_demotion_reaches_the_seam_carrying_its_flag() {
    let target = Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 200.0,
    };
    let viewport = Rect {
        x: 0.0,
        y: 50.0,
        width: 100.0,
        height: 100.0,
    };
    let outside = Point { x: 50.0, y: 10.0 };
    let observed = Cell::new(None);
    let result = resolve_classification(HitClassification::Unrelated, || {
        observed.set(Some(should_demote_outside_viewport(
            &outside,
            &target,
            Some(&viewport),
        )));
        intercepted_stub()
    });
    assert_eq!(
        observed.get(),
        Some(true),
        "corroboration decides the demotion, so the flag must be raised inside the seam"
    );
    assert_eq!(result, intercepted_stub());
}

/// The viewport climb is corroboration's input and nobody else's. A budget
/// that expires inside it answers `Unknown` for the arm that asked and for no
/// other, so a verdict the ancestry already determined cannot be unmade by a
/// walk whose answer that verdict would have discarded — and never pays for
/// the walk in the first place, which is the common case of an unoccluded hit.
#[test]
fn a_budget_expiring_in_the_viewport_walk_cannot_unmake_reaches_target() {
    let climbed = Cell::new(false);
    let result = resolve_classification(HitClassification::ReachesTarget, || {
        climbed.set(true);
        result_for_incomplete_walk()
    });
    assert_eq!(
        result,
        HitTestResult::ReachesTarget,
        "a truncated viewport climb must not demote a determined verdict"
    );
    assert!(
        !climbed.get(),
        "a reaching hit must not spend the viewport climb at all"
    );
}

#[test]
fn classify_hit_self_and_descendant_and_ancestor_arms() {
    let parents: HashMap<i32, i32> = [(2, 1), (3, 1)].into_iter().collect();
    let parent_of = |node: &i32| match parents.get(node) {
        Some(parent) => Ok(Some(*parent)),
        None => Ok(None),
    };
    let same = |left: &i32, right: &i32| left == right;
    let identity = |node: &i32| NodeKey::Runtime(vec![*node]);
    let walk = AncestryWalk {
        same_element: &same,
        identity: &identity,
        parent_of: &parent_of,
        deadline: deadline(),
    };

    assert_eq!(
        classify_hit_with(&1, &1, &walk),
        Some(HitClassification::ReachesTarget)
    );
    assert_eq!(
        classify_hit_with(&1, &2, &walk),
        Some(HitClassification::ReachesTarget)
    );
    assert_eq!(
        classify_hit_with(&2, &1, &walk),
        Some(HitClassification::AncestorOfTarget)
    );
    assert_eq!(
        classify_hit_with(&2, &3, &walk),
        Some(HitClassification::Unrelated)
    );
}

#[test]
fn demotion_outside_target_viewport_intersection() {
    let target = Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 200.0,
    };
    let viewport = Rect {
        x: 0.0,
        y: 50.0,
        width: 100.0,
        height: 100.0,
    };
    let outside = Point { x: 50.0, y: 10.0 };
    let inside = Point { x: 50.0, y: 80.0 };
    assert!(should_demote_outside_viewport(
        &outside,
        &target,
        Some(&viewport)
    ));
    assert!(!should_demote_outside_viewport(
        &inside,
        &target,
        Some(&viewport)
    ));
    assert!(!should_demote_outside_viewport(&outside, &target, None));
}

#[test]
fn ancestry_cycle_terminates_as_incomplete_never_hangs() {
    let parents: HashMap<i32, i32> = [(1, 2), (2, 1)].into_iter().collect();
    let steps = Cell::new(0);
    let same = |left: &i32, right: &i32| left == right;
    let identity = |node: &i32| NodeKey::Runtime(vec![*node]);
    let parent_of = |node: &i32| {
        steps.set(steps.get() + 1);
        assert!(steps.get() <= 60, "cycle walk must not hang");
        Ok(Some(parents[node]))
    };
    let walk = AncestryWalk {
        same_element: &same,
        identity: &identity,
        parent_of: &parent_of,
        deadline: deadline(),
    };
    assert_eq!(ancestry_with(&1, &99, 50, &walk), Ancestry::Incomplete);
}

/// Each ancestor step is a cross-process call, so a budget consulted only
/// before the phase lets a long chain run arbitrarily far past the deadline.
#[test]
fn an_expired_budget_truncates_the_walk_mid_chain_to_unknown() {
    const CHAIN: i32 = 8;
    let parents: HashMap<i32, i32> = (1..CHAIN).map(|node| (node, node + 1)).collect();
    let steps = Cell::new(0);
    let same = |left: &i32, right: &i32| left == right;
    let identity = |node: &i32| NodeKey::Runtime(vec![*node]);
    let parent_of = |node: &i32| {
        steps.set(steps.get() + 1);
        std::thread::sleep(std::time::Duration::from_millis(120));
        Ok(parents.get(node).copied())
    };
    let walk = AncestryWalk {
        same_element: &same,
        identity: &identity,
        parent_of: &parent_of,
        deadline: Deadline::after(200).expect("a bounded budget"),
    };

    assert_eq!(ancestry_with(&1, &99, 50, &walk), Ancestry::Incomplete);
    assert!(
        steps.get() >= 1,
        "the budget must be spent by real steps, not refused before the first"
    );
    assert!(
        steps.get() < CHAIN,
        "an expired budget must truncate the walk instead of running the chain out"
    );
    assert_eq!(
        classify_hit_with(&1, &99, &walk),
        None,
        "a truncated walk leaves the relation unproven"
    );
    let result = result_for_incomplete_walk();
    assert_eq!(result, HitTestResult::Unknown);
    assert!(
        !matches!(result, HitTestResult::InterceptedBy { .. }),
        "a truncated walk must never invent InterceptedBy"
    );
}

#[test]
fn a_probe_miss_is_unknown_and_never_reaches_judging() {
    let outcome = judge_probe(None::<()>, |_| panic!("a probe miss must not be judged"));

    assert_eq!(
        outcome.expect("a probe miss is Ok(Unknown), never Err"),
        HitTestResult::Unknown
    );
}

#[test]
fn a_probe_hit_is_judged_not_collapsed_to_unknown() {
    let outcome = judge_probe(Some(()), |()| HitTestResult::ReachesTarget);

    assert_eq!(
        outcome.expect("a probe hit is judged"),
        HitTestResult::ReachesTarget
    );
}

#[test]
fn settled_absent_pre_read_demotes_to_unknown() {
    assert!(pre_read_fate_for_test(UiaFailure::Hresult(UIA_E_NOTSUPPORTED)).is_ok());
    assert!(pre_read_fate_for_test(UiaFailure::Sentinel(ERR_INVALID_ARG)).is_ok());
}

#[test]
fn terminal_unclassified_pre_read_demotes_to_unknown() {
    assert!(pre_read_fate_for_test(UiaFailure::Hresult(E_FAIL)).is_ok());
}

#[test]
fn transport_retryable_pre_read_escapes_as_err() {
    let error = pre_read_fate_for_test(UiaFailure::Hresult(UIA_E_TIMEOUT))
        .expect_err("retryable pre-read must escape");
    assert!(error.is_explicitly_retryable());
    let error = pre_read_fate_for_test(UiaFailure::Sentinel(ERR_TIMEOUT))
        .expect_err("timeout sentinel must escape");
    assert!(error.is_explicitly_retryable());
}

#[test]
fn permission_pre_read_escapes_as_err() {
    let error = pre_read_fate_for_test(UiaFailure::Hresult(E_ACCESSDENIED))
        .expect_err("permission denial must escape");
    assert_eq!(error.code, ErrorCode::PermDenied);
}

#[test]
fn dead_token_preamble_escapes_as_stale_reader_err() {
    ensure_test_apartment();
    let fixture = LocalFixture::create().expect("off-screen fixture starts");
    let (left, top) = fixture.origin();
    let root = root_from_hwnd(fixture.handle(), deadline()).expect("fixture root");
    let handle = root
        .with_verified_process(std::process::id(), "dead-token-for-hit-test".into())
        .into_native_handle();
    let error = hit_test_impl(
        &handle,
        Point {
            x: f64::from(left + 20),
            y: f64::from(top + 20),
        },
        deadline(),
    )
    .expect_err("a dead verified token must escape");
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn saturating_physical_point_never_panics() {
    assert_eq!(saturate_coord(f64::from(i32::MAX) + 10.0), i32::MAX);
    assert_eq!(saturate_coord(f64::from(i32::MIN) - 10.0), i32::MIN);
    let point = physical_point(&Point { x: 12.7, y: -3.2 });
    assert_eq!(point.get_x(), 12);
    assert_eq!(point.get_y(), -3);
}

#[test]
fn remember_ancestor_detects_runtime_id_cycles() {
    let mut keys = Vec::new();
    let mut unkeyed: Vec<i32> = Vec::new();
    let same = |left: &i32, right: &i32| left == right;
    assert!(remember_ancestor_key(
        &mut keys,
        &mut unkeyed,
        NodeKey::Runtime(vec![1, 2]),
        &1,
        &same
    ));
    assert!(!remember_ancestor_key(
        &mut keys,
        &mut unkeyed,
        NodeKey::Runtime(vec![1, 2]),
        &1,
        &same
    ));
}

fn intercepted_stub() -> HitTestResult {
    HitTestResult::InterceptedBy {
        role: Some("pane".into()),
        name: None,
        bounds: None,
    }
}
