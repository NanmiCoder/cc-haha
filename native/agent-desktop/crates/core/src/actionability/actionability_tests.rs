use super::*;
use crate::tree::state;
use crate::{
    Action, Direction, ErrorCode, Rect, actions::action_request::ActionRequest,
    actions::capability, adapter::SnapshotSurface, refs::RefEntry,
};

fn entry() -> RefEntry {
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    };
    RefEntry {
        process: crate::RefProcess {
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
        },
        identity: crate::RefEntryIdentity {
            retained_object: None,
            role: "button".into(),
            name: Some("OK".into()),
            value: None,
            description: None,
            native_id: None,
        },
        geometry: crate::RefGeometry {
            bounds_space: None,
            bounds: Some(bounds),
            bounds_hash: bounds.bounds_hash(),
        },
        capabilities: crate::RefCapabilities {
            states: vec![],
            available_actions: vec![capability::CLICK.into()],
        },
        source: crate::RefSource {
            source_app: None,
            source_window_id: None,
            source_window_title: None,
            source_window_bounds_hash: None,
            source_surface: SnapshotSurface::Window,
        },
        scope: crate::RefScope {
            root_ref: None,
            path_is_absolute: true,
            path: smallvec::SmallVec::new(),
        },
    }
}

fn visibility_evidence(
    hidden: Option<bool>,
    states: Vec<String>,
    states_complete: bool,
) -> evidence::ActionabilityEvidence {
    evidence::ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: "button".into(),
            states,
            value: None,
            enabled: Some(true),
            hidden,
            offscreen: Some(false),
        },
        states_complete,
        bounds: Some(Rect {
            x: 1.0,
            y: 1.0,
            width: 20.0,
            height: 20.0,
        }),
        available_actions: vec![capability::CLICK.into()],
    }
}

#[test]
fn explicit_typed_hidden_state_wins() {
    let check = gates::visibility(
        &visibility_evidence(Some(true), Vec::new(), true),
        true,
        false,
    );

    assert_eq!(check.status, ActionabilityStatus::Fail);
    assert_eq!(check.reason.as_deref(), Some("live hidden state is true"));
}

#[test]
fn complete_canonical_hidden_state_fails_when_typed_state_is_absent() {
    let check = gates::visibility(
        &visibility_evidence(None, vec![state::HIDDEN.into()], true),
        true,
        false,
    );

    assert_eq!(check.status, ActionabilityStatus::Fail);
    assert_eq!(
        check.reason.as_deref(),
        Some("canonical hidden state is present")
    );
}

#[test]
fn complete_canonical_states_without_hidden_allow_visibility_checks_to_continue() {
    let check = gates::visibility(&visibility_evidence(None, Vec::new(), true), true, false);

    assert_eq!(check.status, ActionabilityStatus::Pass);
}

#[test]
fn incomplete_canonical_states_keep_missing_typed_hidden_unknown() {
    let check = gates::visibility(&visibility_evidence(None, Vec::new(), false), true, false);

    assert_eq!(check.status, ActionabilityStatus::Unknown);
    assert_eq!(
        check.reason.as_deref(),
        Some("live hidden state unavailable")
    );
}

#[test]
fn click_passes_when_target_is_enabled_visible_and_supported() {
    let report = check(&entry(), &ActionRequest::headless(Action::Click)).unwrap();

    assert!(report.actionable);
}

#[test]
fn scroll_to_attempts_adapter_delivery_without_a_native_element_capability() {
    let mut target = entry();
    target.capabilities.available_actions.clear();

    let report = check(&target, &ActionRequest::headless(Action::ScrollTo)).unwrap();

    assert!(report.actionable);
}

#[test]
fn states_are_enabled_reads_the_canonical_disabled_token() {
    assert!(!states_are_enabled(&[state::DISABLED.to_string()]));
    assert!(states_are_enabled(&[]));
    assert!(states_are_enabled(&[state::FOCUSED.to_string()]));
}

#[test]
fn disabled_entry_fails_before_action_dispatch() {
    let mut entry = entry();
    entry.capabilities.states.push("disabled".into());

    let err = check(&entry, &ActionRequest::headless(Action::Click)).unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert!(err.message.contains("enabled"));
    assert_eq!(err.details.as_ref().unwrap()["actionable"], false);
}

#[test]
fn zero_sized_bounds_fail_headed_visibility() {
    let mut entry = entry();
    let bounds = Rect {
        x: 1.0,
        y: 1.0,
        width: 0.0,
        height: 20.0,
    };
    entry.geometry.bounds = Some(bounds);
    entry.geometry.bounds_hash = bounds.bounds_hash();

    let err = check(&entry, &ActionRequest::headed(Action::Click)).unwrap_err();

    assert!(err.message.contains("visible"));
}

#[test]
fn hidden_state_fails_visibility_before_action_dispatch() {
    let mut entry = entry();
    entry.capabilities.states.push(state::HIDDEN.into());

    let err = check(&entry, &ActionRequest::headless(Action::Click)).unwrap_err();

    assert!(err.message.contains("visible"));
}

#[test]
fn offscreen_state_fails_visibility_before_action_dispatch() {
    let mut entry = entry();
    entry.capabilities.states.push(state::OFFSCREEN.into());

    let err = check(&entry, &ActionRequest::headless(Action::Click)).unwrap_err();

    assert!(err.message.contains("visible"));
}

#[test]
fn hidden_entry_fails_visibility_even_when_bounds_are_none() {
    let mut entry = entry();
    entry.capabilities.states.push(state::HIDDEN.into());
    entry.geometry.bounds = None;
    entry.geometry.bounds_hash = None;

    let err = check(&entry, &ActionRequest::headless(Action::Click)).unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert!(err.message.contains("visible"));
    assert!(err.message.contains("hidden"));
}

#[test]
fn offscreen_entry_fails_visibility_even_when_bounds_are_none() {
    let mut entry = entry();
    entry.capabilities.states.push(state::OFFSCREEN.into());
    entry.geometry.bounds = None;
    entry.geometry.bounds_hash = None;

    let err = check(&entry, &ActionRequest::headless(Action::Click)).unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert!(err.message.contains("visible"));
    assert!(err.message.contains("offscreen"));
}

#[test]
fn text_input_requires_editable_target() {
    let err = check(
        &entry(),
        &ActionRequest::focus_fallback(Action::TypeText("hello".into())),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::ActionNotSupported);
    assert!(err.message.contains("editable"));
}

#[test]
fn cell_text_input_explains_how_to_target_the_editor() {
    let mut cell = entry();
    cell.identity.role = "cell".into();
    for action in [Action::TypeText("x".into()), Action::SetValue("x".into())] {
        let error = check(&cell, &ActionRequest::headless(action)).unwrap_err();
        assert!(error.suggestion.unwrap().contains("target the text editor"));
        assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    }
}

#[test]
fn cursor_movement_requires_physical_policy() {
    let err = check(&entry(), &ActionRequest::headless(Action::Hover)).unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("policy"));
}

#[test]
fn headless_type_text_fails_policy_before_dispatch() {
    let mut target = entry();
    target.identity.role = "textfield".into();
    target.capabilities.available_actions = vec![capability::SET_VALUE.into()];

    let err = check(
        &target,
        &ActionRequest::headless(Action::TypeText("x".into())),
    )
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("focus"));
}

#[test]
fn headless_right_click_denies_physical_fallback() {
    let err = check(&entry(), &ActionRequest::headless(Action::RightClick)).unwrap_err();

    assert_eq!(err.code, ErrorCode::PolicyDenied);
    assert!(err.message.contains("supported_action"));
}

#[test]
fn headless_multi_clicks_deny_physical_fallback_before_hit_testing() {
    for action in [Action::DoubleClick, Action::TripleClick] {
        let err = check(&entry(), &ActionRequest::headless(action)).unwrap_err();

        assert_eq!(err.code, ErrorCode::PolicyDenied);
        assert!(err.message.contains("supported_action"));
    }
}

#[test]
fn headed_click_allows_verified_physical_fallback() {
    let mut target = entry();
    target.capabilities.available_actions.clear();

    assert!(check(&target, &ActionRequest::headed(Action::Click)).is_ok());
}

#[test]
fn headed_multi_clicks_require_and_allow_physical_delivery() {
    let mut target = entry();
    target.capabilities.available_actions.clear();

    for action in [Action::DoubleClick, Action::TripleClick] {
        assert!(check(&target, &ActionRequest::headed(action)).is_ok());
    }
}

#[test]
fn command_aliases_match_platform_capabilities() {
    let click_entry = entry();
    assert!(check(&click_entry, &ActionRequest::headless(Action::Check)).is_ok());
    assert!(check(&click_entry, &ActionRequest::headless(Action::Uncheck)).is_ok());

    let mut editable = entry();
    editable.identity.role = "textfield".into();
    editable.capabilities.available_actions = vec![capability::SET_VALUE.into()];
    assert!(check(&editable, &ActionRequest::headless(Action::Clear)).is_ok());

    let mut scrollable = entry();
    scrollable.capabilities.available_actions = vec![capability::SCROLL.into()];
    assert!(
        check(
            &scrollable,
            &ActionRequest::headless(Action::Scroll(Direction::Down, 1))
        )
        .is_ok()
    );
    assert!(check(&scrollable, &ActionRequest::headless(Action::ScrollTo)).is_ok());

    scrollable.capabilities.available_actions = vec![capability::SCROLL_TO.into()];
    assert!(
        check(
            &scrollable,
            &ActionRequest::headless(Action::Scroll(Direction::Down, 1))
        )
        .is_err()
    );
    assert!(check(&scrollable, &ActionRequest::headless(Action::ScrollTo)).is_ok());
}

fn select_evidence(role: &str, actions: Vec<String>) -> evidence::ActionabilityEvidence {
    evidence::ActionabilityEvidence {
        nonspatial: false,
        state: crate::ElementState {
            role: role.into(),
            states: Vec::new(),
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        },
        states_complete: true,
        bounds: Some(Rect {
            x: 1.0,
            y: 1.0,
            width: 20.0,
            height: 20.0,
        }),
        available_actions: actions,
    }
}

fn select_request() -> ActionRequest {
    ActionRequest::headless(Action::Select("Times New Roman".into()))
}

#[test]
fn select_runs_expand_flow_on_expandable_combo_without_direct_select() {
    let evidence = select_evidence(
        "combobox",
        vec![capability::EXPAND.into(), capability::SET_VALUE.into()],
    );

    assert_eq!(
        gates::action_supported(&evidence, &select_request()).status,
        ActionabilityStatus::Pass
    );
}

#[test]
fn select_still_refuses_expandable_non_combo() {
    let evidence = select_evidence("disclosure", vec![capability::EXPAND.into()]);
    let refused = gates::action_supported(&evidence, &select_request());

    assert_eq!(refused.status, ActionabilityStatus::Fail);
    assert_eq!(refused.terminal_code, Some(ErrorCode::ActionNotSupported));
}

#[test]
fn select_still_refuses_combo_without_expand() {
    let evidence = select_evidence("combobox", vec![capability::SET_VALUE.into()]);
    let refused = gates::action_supported(&evidence, &select_request());

    assert_eq!(refused.status, ActionabilityStatus::Fail);
    assert_eq!(refused.terminal_code, Some(ErrorCode::ActionNotSupported));
}
