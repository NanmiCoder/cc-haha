use super::test_support::{
    PredicateAdapter, snapshot_with_disabled_ref, snapshot_with_one_ref, wait_for_element_test,
};
use super::*;
use crate::actions::action_request;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AdapterError, adapter::NativeHandle, commands::wait_predicate, refs::RefEntry,
    refs::refs_test_support::HomeGuard, tree::element_state::ElementState,
};
use std::sync::Mutex;

fn live_bounds() -> Option<crate::Rect> {
    Some(crate::Rect {
        x: 1.0,
        y: 1.0,
        width: 20.0,
        height: 20.0,
    })
}

struct FlippingPredicateAdapter {
    states: Mutex<Vec<Vec<String>>>,
    remaining_errors: Mutex<usize>,
}

impl ObservationOps for FlippingPredicateAdapter {
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
    ) -> Result<crate::LiveElement, AdapterError> {
        let mut remaining_errors = self.remaining_errors.lock().unwrap();
        if *remaining_errors > 0 {
            *remaining_errors -= 1;
            return Err(AdapterError::app_unresponsive("Fixture")
                .with_details(serde_json::json!({ "retryable": true })));
        }
        drop(remaining_errors);
        let states = self.states.lock().unwrap().pop().unwrap_or_default();
        Ok(crate::LiveElement {
            identity: crate::adapter::live_identity("Run"),
            state: ElementState {
                role: "button".into(),
                states,
                value: None,
                enabled: Some(true),
                hidden: Some(false),
                offscreen: Some(false),
            },
            states_complete: true,
            bounds: live_bounds(),
            available_actions: vec![crate::actions::capability::CLICK.into()],
        })
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        let states = self.states.lock().unwrap().pop().unwrap_or_default();
        Ok(Some(ElementState {
            role: "button".into(),
            states,
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: Some(false),
        }))
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::Rect>, AdapterError> {
        Ok(Some(crate::Rect {
            x: 1.0,
            y: 1.0,
            width: 20.0,
            height: 20.0,
        }))
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Ok(Some(vec![crate::actions::capability::CLICK.into()]))
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

impl ActionOps for FlippingPredicateAdapter {}

impl InputOps for FlippingPredicateAdapter {}

impl SystemOps for FlippingPredicateAdapter {}

#[test]
fn element_wait_enabled_predicate_uses_live_state() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
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
        bounds: live_bounds(),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Enabled,
        50,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["predicate"], "enabled");
    assert_eq!(value["observed"]["enabled"], true);
}

#[test]
fn element_wait_value_predicate_matches_live_value_without_leaking_it() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
    let adapter = PredicateAdapter {
        state: None,
        value: Some("ready".into()),
        bounds: live_bounds(),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Value("ready".into()),
        50,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["predicate"], "value");
    assert_eq!(value["observed"]["matched"], true);
    assert_eq!(value["observed"]["value_chars"], 5);
    assert!(value["observed"].get("value").is_none());
}

#[test]
fn element_wait_timeout_reports_last_actionability_observation() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_disabled_ref();
    let adapter = PredicateAdapter {
        state: Some(ElementState {
            role: "button".into(),
            states: vec!["disabled".into()],
            value: None,
            enabled: Some(false),
            hidden: Some(false),
            offscreen: Some(false),
        }),
        value: None,
        bounds: live_bounds(),
    };

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Actionable(action_request::ActionRequest::headless(
            crate::actions::action::Action::Click,
        )),
        50,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    match err {
        AppError::Adapter(adapter_error) => {
            let details = adapter_error.details.unwrap();
            assert_eq!(details["predicate"], "actionable");
            assert_eq!(details["last_observed"]["actionable"], false);
        }
        _ => panic!("expected adapter error"),
    }
}

#[test]
fn element_wait_actionable_uses_live_state() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_disabled_ref();
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
        bounds: live_bounds(),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Actionable(action_request::ActionRequest::headless(
            crate::actions::action::Action::Click,
        )),
        500,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["predicate"], "actionable");
    assert_eq!(value["observed"]["actionable"], true);
}

#[test]
fn element_wait_actionable_retries_until_live_state_converges() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_disabled_ref();
    let adapter = FlippingPredicateAdapter {
        states: Mutex::new(vec![vec![], vec!["disabled".into()]]),
        remaining_errors: Mutex::new(0),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Actionable(action_request::ActionRequest::headless(
            crate::actions::action::Action::Click,
        )),
        5_000,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["predicate"], "actionable");
    assert_eq!(value["observed"]["actionable"], true);
}

#[test]
fn element_wait_actionable_retries_transient_observation_errors() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_disabled_ref();
    let adapter = FlippingPredicateAdapter {
        states: Mutex::new(vec![vec![]]),
        remaining_errors: Mutex::new(1),
    };

    let value = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Actionable(action_request::ActionRequest::headless(
            crate::actions::action::Action::Click,
        )),
        500,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["observed"]["actionable"], true);
    assert_eq!(*adapter.remaining_errors.lock().unwrap(), 0);
}

#[test]
fn element_wait_actionable_type_fails_on_uneditable_role() {
    let _guard = HomeGuard::new();
    let snapshot_id = snapshot_with_one_ref();
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
        bounds: live_bounds(),
    };

    let err = wait_for_element_test(
        "@e1".into(),
        Some(snapshot_id),
        wait_predicate::ElementPredicate::Actionable(action_request::ActionRequest::headless(
            crate::actions::action::Action::TypeText(String::new()),
        )),
        50,
        &adapter,
        &crate::context::CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "ACTION_NOT_SUPPORTED");
    match err {
        AppError::Adapter(adapter_error) => {
            let details = adapter_error.details.unwrap();
            assert_eq!(details["actionable"], false);
            let editable = details["checks"]
                .as_array()
                .expect("a terminal actionability failure carries the check report")
                .iter()
                .find(|check| check["check"] == "editable")
                .expect("the editable check is reported");
            assert_eq!(editable["status"], "fail");
        }
        _ => panic!("expected adapter error"),
    }
}

#[test]
fn wait_action_flag_is_rejected_outside_actionable_predicate() {
    let err =
        wait_predicate::ElementPredicate::parse(Some("enabled"), None, Some("type")).unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn wait_actionable_rejects_unknown_action() {
    let err = wait_predicate::ElementPredicate::parse(Some("actionable"), None, Some("hover"))
        .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn actionable_parse_mirrors_each_real_command_policy() {
    use crate::actions::interaction_policy::InteractionPolicy;

    let request_for = |name: Option<&str>| match wait_predicate::ElementPredicate::parse(
        Some("actionable"),
        None,
        name,
    )
    .unwrap()
    {
        wait_predicate::ElementPredicate::Actionable(request) => request,
        other => panic!("expected actionable predicate, got {other:?}"),
    };

    assert_eq!(request_for(None).policy, InteractionPolicy::headless());
    assert_eq!(
        request_for(Some("click")).policy,
        InteractionPolicy::headless()
    );
    assert_eq!(
        request_for(Some("type")).policy,
        InteractionPolicy::headless()
    );
    assert_eq!(
        request_for(Some("set-value")).policy,
        InteractionPolicy::headless()
    );
    assert_eq!(
        request_for(Some("clear")).policy,
        InteractionPolicy::headless()
    );
}
