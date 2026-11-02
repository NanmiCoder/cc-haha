use super::{
    Attribution, OCCLUDER_EVIDENCE_PROPERTIES, WindowOpinion, interception_attribution,
    interception_outcome, occluder_from_properties,
};
use crate::tree::name_evidence::LabelOutcome;
use crate::tree::properties::element_properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};
use agent_desktop_core::{Rect, adapter::hit_test::HitTestResult};
use std::cell::Cell;

#[test]
fn arm1_same_root_agrees() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(10), Some(1)),
            opinion(Some(10), Some(1)),
        ),
        Attribution::SameRoot
    );
}

#[test]
fn arm2_cross_window_roots_agree() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(20), Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::CrossWindow
    );
}

#[test]
fn arm3_pid_widening_when_hit_root_unobtainable() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(None, Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::CrossWindow
    );
}

#[test]
fn arm3_pid_equal_never_widens() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(None, Some(1)),
            opinion(Some(20), Some(1)),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn three_distinct_roots_is_unknown() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(20), Some(2)),
            opinion(Some(30), Some(3)),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn target_root_failure_is_unknown() {
    assert_eq!(
        interception_attribution(
            opinion(None, Some(1)),
            opinion(Some(20), Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn win32_root_failure_is_unknown() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(20), Some(2)),
            opinion(None, None),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn unreadable_pid_blocks_widening() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(None, None),
            opinion(Some(20), Some(2)),
        ),
        Attribution::Contradicted
    );
    assert_eq!(
        interception_attribution(
            opinion(Some(10), None),
            opinion(None, Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::Contradicted
    );
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(None, Some(2)),
            opinion(Some(20), None),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn zero_handles_are_treated_as_unobtainable() {
    assert_eq!(
        interception_attribution(
            opinion(Some(0), Some(1)),
            opinion(Some(20), Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::Contradicted
    );
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(0), Some(2)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::CrossWindow,
        "a zero hit root is unobtainable, which is the pid-widening row"
    );
}

/// The unclipped-rect demotion answers a same-window question, so it silences
/// the same-root arm only: a cross-window occluder both opinions agree on is
/// evidence wherever the candidate point falls inside the target's rect.
#[test]
fn the_viewport_demotion_silences_only_the_same_root_arm() {
    assert_eq!(
        interception_outcome(Attribution::SameRoot, true, evidence_stub),
        HitTestResult::Unknown
    );
    assert_eq!(
        interception_outcome(Attribution::CrossWindow, true, evidence_stub),
        intercepted_stub(),
        "a corroborated cross-window occluder survives the demotion"
    );
    assert_eq!(
        interception_outcome(Attribution::SameRoot, false, evidence_stub),
        intercepted_stub()
    );
    assert_eq!(
        interception_outcome(Attribution::CrossWindow, false, evidence_stub),
        intercepted_stub()
    );
}

#[test]
fn a_demoted_or_contradicted_outcome_never_reads_evidence() {
    for (attribution, demote) in [
        (Attribution::Contradicted, false),
        (Attribution::Contradicted, true),
        (Attribution::SameRoot, true),
    ] {
        let read = Cell::new(false);
        let result = interception_outcome(attribution, demote, || {
            read.set(true);
            Some(intercepted_stub())
        });
        assert_eq!(result, HitTestResult::Unknown);
        assert!(
            !read.get(),
            "{attribution:?} with demote={demote} must not spend an evidence batch"
        );
    }
}

#[test]
fn unassembled_evidence_is_unknown_not_a_nameless_interception() {
    assert_eq!(
        interception_outcome(Attribution::CrossWindow, false, || None),
        HitTestResult::Unknown
    );
}

#[test]
fn occluder_evidence_batch_includes_is_password() {
    assert!(
        OCCLUDER_EVIDENCE_PROPERTIES.contains(&TreeProperty::IsPassword),
        "withholding is batch-conditional on IsPassword being in the read set"
    );
}

#[test]
fn password_occluder_name_is_withheld() {
    let properties = ElementProperties::from_reads(vec![
        (
            TreeProperty::IsPassword,
            PropertyOutcome::Known(PropertyValue::Flag(true)),
        ),
        (
            TreeProperty::Name,
            PropertyOutcome::Known(PropertyValue::Text("zzfixturesecretzz".into())),
        ),
        (
            TreeProperty::ControlType,
            PropertyOutcome::Known(PropertyValue::Number(50004)),
        ),
        (
            TreeProperty::BoundingRectangle,
            PropertyOutcome::Known(PropertyValue::Bounds(Rect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            })),
        ),
    ]);
    let result = occluder_from_properties(&properties, LabelOutcome::Unlabelled)
        .expect("evidence assembles");
    match result {
        HitTestResult::InterceptedBy { name, role, .. } => {
            assert_eq!(name, None);
            assert_eq!(role, Some("textfield".into()));
        }
        other => panic!("expected InterceptedBy, got {other:?}"),
    }
}

#[test]
fn control_type_failure_still_reports_unknown_role() {
    let properties = ElementProperties::from_reads(vec![
        (TreeProperty::IsPassword, PropertyOutcome::Absent),
        (TreeProperty::ControlType, PropertyOutcome::Unknown),
        (
            TreeProperty::BoundingRectangle,
            PropertyOutcome::Known(PropertyValue::Bounds(Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            })),
        ),
    ]);
    let result = occluder_from_properties(&properties, LabelOutcome::Unlabelled)
        .expect("evidence assembles");
    match result {
        HitTestResult::InterceptedBy { role, .. } => {
            assert_eq!(role, Some("unknown".into()));
        }
        other => panic!("expected InterceptedBy, got {other:?}"),
    }
}

#[test]
fn bounds_read_failure_demotes_evidence() {
    let properties = ElementProperties::from_reads(vec![
        (TreeProperty::IsPassword, PropertyOutcome::Absent),
        (
            TreeProperty::ControlType,
            PropertyOutcome::Known(PropertyValue::Number(50000)),
        ),
        (TreeProperty::BoundingRectangle, PropertyOutcome::Unknown),
    ]);
    assert!(occluder_from_properties(&properties, LabelOutcome::Unlabelled).is_none());
}

#[test]
fn flipped_arm1_must_not_agree_when_win32_differs() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(10), Some(1)),
            opinion(Some(20), Some(2)),
        ),
        Attribution::Contradicted
    );
}

#[test]
fn flipped_arm2_must_not_agree_when_win32_matches_target() {
    assert_eq!(
        interception_attribution(
            opinion(Some(10), Some(1)),
            opinion(Some(20), Some(2)),
            opinion(Some(10), Some(1)),
        ),
        Attribution::Contradicted
    );
}

/// One window's pair, named at the call site so a root can never be read
/// as another window's pid.
fn opinion(root: Option<isize>, pid: Option<u32>) -> WindowOpinion {
    WindowOpinion { root, pid }
}

fn evidence_stub() -> Option<HitTestResult> {
    Some(intercepted_stub())
}

fn intercepted_stub() -> HitTestResult {
    HitTestResult::InterceptedBy {
        role: Some("pane".into()),
        name: None,
        bounds: None,
    }
}
