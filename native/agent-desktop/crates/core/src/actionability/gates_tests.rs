use super::visibility;
use crate::actionability::evaluate::build_report;
use crate::actionability::evidence::ActionabilityEvidence;
use crate::actionability::stability::StabilityExpectation;
use crate::actionability::status::ActionabilityStatus;
use crate::{Action, ActionRequest, ElementState, Rect};

fn evidence(offscreen: Option<bool>, bounds: Option<Rect>) -> ActionabilityEvidence {
    ActionabilityEvidence {
        nonspatial: false,
        state: ElementState {
            role: "button".into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen,
        },
        states_complete: true,
        bounds,
        available_actions: vec![],
    }
}

#[test]
fn a_known_on_screen_node_passes_without_bounds_when_no_geometry_is_needed() {
    let check = visibility(&evidence(Some(false), None), false, false);
    assert_eq!(check.status, ActionabilityStatus::Pass);
}

#[test]
fn geometry_that_is_required_still_needs_bounds() {
    let check = visibility(&evidence(Some(false), None), true, false);
    assert_eq!(check.status, ActionabilityStatus::Unknown);
}

#[test]
fn an_unknown_offscreen_state_without_bounds_stays_unknown() {
    let check = visibility(&evidence(None, None), false, false);
    assert_eq!(check.status, ActionabilityStatus::Unknown);
}

#[test]
fn a_known_on_screen_node_with_zero_sized_bounds_still_fails() {
    let zero = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
    let check = visibility(&evidence(Some(false), Some(zero)), false, false);
    assert_eq!(check.status, ActionabilityStatus::Fail);
    assert_eq!(check.reason.as_deref(), Some("bounds are zero-sized"));
}

fn status_of(
    action: Action,
    headed: bool,
    offscreen: Option<bool>,
    bounds: Option<Rect>,
    available: &[&str],
    check: &str,
) -> Option<ActionabilityStatus> {
    let mut shown = evidence(offscreen, bounds);
    shown.available_actions = available.iter().map(|name| (*name).to_owned()).collect();
    let request = if headed {
        ActionRequest::headed(action)
    } else {
        ActionRequest::headless(action)
    };
    let hash = bounds.and_then(|rect| rect.bounds_hash());
    let report = build_report(
        StabilityExpectation::permissive(hash),
        &shown,
        &request,
        None,
        crate::Deadline::standard().expect("a deadline"),
    )
    .expect("a report");
    report
        .checks
        .into_iter()
        .find(|found| found.check == check)
        .map(|found| found.status)
}

const TOGGLE: &[&str] = &["Toggle"];
const CLICK: &[&str] = &["Click"];

fn rect() -> Rect {
    Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    }
}

#[test]
fn a_semantic_toggle_with_no_bounds_on_a_known_on_screen_node_passes_visible_and_stable() {
    for check in ["visible", "stable"] {
        let status = status_of(Action::Toggle, false, Some(false), None, TOGGLE, check);
        assert_eq!(status, Some(ActionabilityStatus::Pass), "{check}");
    }
}

#[test]
fn a_toggle_with_bounds_still_runs_the_stability_check() {
    let status = status_of(
        Action::Toggle,
        false,
        Some(false),
        Some(rect()),
        TOGGLE,
        "stable",
    );
    assert_eq!(status, Some(ActionabilityStatus::Pass));
    let strict = status_of(Action::Toggle, false, None, None, TOGGLE, "stable");
    assert_eq!(strict, Some(ActionabilityStatus::Unknown));
}

#[test]
fn a_toggle_with_no_bounds_and_an_unknown_offscreen_state_stays_unknown() {
    for check in ["visible", "stable"] {
        let status = status_of(Action::Toggle, false, None, None, TOGGLE, check);
        assert_eq!(status, Some(ActionabilityStatus::Unknown), "{check}");
    }
}

#[test]
fn pointer_delivery_never_gets_the_boundless_pass() {
    let headed = status_of(Action::Toggle, true, Some(false), None, TOGGLE, "visible");
    assert_eq!(headed, Some(ActionabilityStatus::Unknown));
    let stable = status_of(Action::Hover, false, Some(false), None, &[], "stable");
    assert_eq!(stable, Some(ActionabilityStatus::Unknown));
    let no_verb = status_of(Action::Toggle, false, Some(false), None, &[], "stable");
    assert_eq!(no_verb, Some(ActionabilityStatus::Unknown));
    let click = status_of(
        Action::DoubleClick,
        false,
        Some(false),
        None,
        CLICK,
        "visible",
    );
    assert_eq!(click, Some(ActionabilityStatus::Unknown));
}

#[test]
fn a_headed_type_needs_no_pointer_bounds_on_a_known_on_screen_node() {
    let typed = Action::TypeText("hello".into());
    let passed = status_of(
        typed.clone(),
        true,
        Some(false),
        None,
        &["TypeText"],
        "visible",
    );
    assert_eq!(passed, Some(ActionabilityStatus::Pass));
    let unknown = status_of(typed, true, None, None, &["TypeText"], "visible");
    assert_eq!(unknown, Some(ActionabilityStatus::Unknown));
}

#[test]
fn visible_without_bounds_agrees_with_the_visibility_gate_for_every_state() {
    for hidden in [None, Some(true), Some(false)] {
        for offscreen in [None, Some(true), Some(false)] {
            for token in [
                None,
                Some(crate::tree::state::HIDDEN),
                Some(crate::tree::state::OFFSCREEN),
            ] {
                let mut probe = evidence(offscreen, None);
                probe.state.hidden = hidden;
                probe.state.states = token.map(String::from).into_iter().collect();
                let Some(verdict) = probe.state.visible_without_bounds() else {
                    continue;
                };
                let gate = visibility(&probe, false, false);
                assert_eq!(
                    gate.status == ActionabilityStatus::Pass,
                    verdict,
                    "hidden {hidden:?} offscreen {offscreen:?} token {token:?}"
                );
            }
        }
    }
}
