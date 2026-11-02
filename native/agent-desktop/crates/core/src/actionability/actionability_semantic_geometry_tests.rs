use super::*;

#[path = "actionability_nonspatial_tests.rs"]
mod nonspatial_tests;

struct GeometryAdapter(LiveElement);

impl ObservationOps for GeometryAdapter {
    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Ok(self.0.clone())
    }

    fn hit_test(
        &self,
        _handle: &NativeHandle,
        _point: crate::Point,
        _deadline: crate::Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        panic!("zero geometry must not reach hit testing")
    }
}

impl ActionOps for GeometryAdapter {}
impl InputOps for GeometryAdapter {}
impl SystemOps for GeometryAdapter {}

fn target(role: &str, actions: &[&str]) -> (RefEntry, GeometryAdapter) {
    let mut target = entry();
    target.identity.role = role.into();
    let bounds = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
    target.geometry.bounds = Some(bounds);
    target.geometry.bounds_hash = bounds.bounds_hash();
    let adapter = GeometryAdapter(LiveElement {
        identity: crate::adapter::live_identity("OK"),
        state: ElementState {
            role: role.into(),
            states: vec![],
            value: None,
            enabled: Some(true),
            hidden: Some(false),
            offscreen: None,
        },
        states_complete: true,
        bounds: Some(bounds),
        available_actions: actions.iter().map(|action| (*action).into()).collect(),
    });
    (target, adapter)
}

fn evaluate(
    target: &RefEntry,
    adapter: &GeometryAdapter,
    request: ActionRequest,
) -> Result<report::ActionabilityReport, AdapterError> {
    check_live(target, &NativeHandle::null(), adapter, &request)
}

#[test]
fn supported_headless_menu_click_accepts_zero_geometry() {
    let (target, adapter) = target("menuitem", &[capability::CLICK]);
    let report = evaluate(&target, &adapter, ActionRequest::headless(Action::Click)).unwrap();

    assert!(report.actionable);
    assert_eq!(report.pointer_delivery, PointerDelivery::Semantic);
    assert_eq!(report.verified_point, None);
    assert_eq!(report.presentation_point, None);
}

#[test]
fn supported_headless_editor_operations_accept_zero_geometry() {
    let (target, adapter) = target("textfield", &[capability::TYPE_TEXT, capability::SET_VALUE]);
    for action in [
        Action::TypeText("x".into()),
        Action::SetValue("x".into()),
        Action::Clear,
    ] {
        let report = evaluate(&target, &adapter, ActionRequest::headless(action)).unwrap();
        assert!(report.actionable);
        assert_eq!(report.verified_point, None);
        assert_eq!(report.presentation_point, None);
    }
}

#[test]
fn targets_without_bounds_still_need_geometry_headless() {
    for (role, action, capability) in [
        ("menuitem", Action::Click, capability::CLICK),
        ("menuitem", Action::RightClick, capability::RIGHT_CLICK),
        (
            "textfield",
            Action::TypeText("x".into()),
            capability::TYPE_TEXT,
        ),
    ] {
        let (target, mut adapter) = target(role, &[capability]);
        adapter.0.bounds = None;
        adapter.0.state.offscreen = None;
        assert!(
            evaluate(&target, &adapter, ActionRequest::headless(action)).is_err(),
            "without bounds the owning window cannot be ruled out, so {role} must not skip the check"
        );
    }
}

#[test]
fn headed_and_physical_actions_still_require_geometry() {
    let (target, adapter) = target(
        "textfield",
        &[
            capability::CLICK,
            capability::RIGHT_CLICK,
            capability::TYPE_TEXT,
            capability::SET_VALUE,
        ],
    );
    for action in [
        Action::Click,
        Action::RightClick,
        Action::DoubleClick,
        Action::TripleClick,
        Action::Hover,
        Action::Clear,
        Action::SetValue("x".into()),
        Action::Drag(crate::DragParams {
            from: crate::Point { x: 0.0, y: 0.0 },
            to: crate::Point { x: 1.0, y: 1.0 },
            duration_ms: None,
            drop_delay_ms: None,
        }),
    ] {
        let err = evaluate(&target, &adapter, ActionRequest::headed(action)).unwrap_err();
        assert!(err.message.contains("visible (bounds are zero-sized)"));
        assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
    }
    let err = evaluate(
        &target,
        &adapter,
        ActionRequest::focus_fallback(Action::SetValue("x".into())),
    )
    .unwrap_err();
    assert!(err.message.contains("visible"));
}

#[test]
fn headed_typing_needs_no_geometry_but_still_needs_a_known_on_screen_state() {
    let (target, adapter) = target("textfield", &[capability::TYPE_TEXT]);
    let report = evaluate(
        &target,
        &adapter,
        ActionRequest::headed(Action::TypeText("x".into())),
    )
    .expect("keyboard delivery never aims a pointer");
    assert!(report.actionable);

    let mut hidden = adapter.0.clone();
    hidden.state.offscreen = Some(true);
    let err = evaluate(
        &target,
        &GeometryAdapter(hidden),
        ActionRequest::headed(Action::TypeText("x".into())),
    )
    .unwrap_err();
    assert!(err.message.contains("offscreen"));

    let mut unreadable = adapter.0.clone();
    unreadable.bounds = None;
    unreadable.state.offscreen = None;
    let err = evaluate(
        &target,
        &GeometryAdapter(unreadable),
        ActionRequest::headed(Action::TypeText("x".into())),
    )
    .unwrap_err();
    assert!(err.message.contains("bounds unavailable"));
}

#[test]
fn semantic_geometry_exception_preserves_live_state_gates() {
    for action in [Action::Click, Action::TypeText("x".into())] {
        let (target, adapter) = target("textfield", &[capability::CLICK, capability::TYPE_TEXT]);
        for (state, reason) in [
            (
                ElementState {
                    hidden: Some(true),
                    ..adapter.0.state.clone()
                },
                "hidden",
            ),
            (
                ElementState {
                    offscreen: Some(true),
                    ..adapter.0.state.clone()
                },
                "offscreen",
            ),
            (
                ElementState {
                    enabled: Some(false),
                    ..adapter.0.state.clone()
                },
                "enabled",
            ),
            (
                ElementState {
                    enabled: None,
                    ..adapter.0.state.clone()
                },
                "enabled",
            ),
            (
                ElementState {
                    hidden: None,
                    ..adapter.0.state.clone()
                },
                "hidden",
            ),
            (
                ElementState {
                    offscreen: None,
                    ..adapter.0.state.clone()
                },
                "offscreen",
            ),
        ] {
            let mut live = adapter.0.clone();
            live.state = state;
            live.states_complete = false;
            let err = evaluate(
                &target,
                &GeometryAdapter(live),
                ActionRequest::headless(action.clone()),
            )
            .unwrap_err();
            assert!(err.message.contains(reason));
            assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
        }
        for hidden in [true, false] {
            let mut live = adapter.0.clone();
            if hidden {
                live.state.hidden = None;
                live.state.states.push(crate::tree::state::HIDDEN.into());
            } else {
                live.state.offscreen = None;
                live.state.states.push(crate::tree::state::OFFSCREEN.into());
            }
            let err = evaluate(
                &target,
                &GeometryAdapter(live),
                ActionRequest::headless(action.clone()),
            )
            .unwrap_err();
            assert!(err.message.contains("canonical"));
        }
    }
}

#[test]
fn semantic_geometry_exception_requires_live_support_and_editability() {
    let (target, mut adapter) = target("button", &[capability::TYPE_TEXT]);
    let err = evaluate(
        &target,
        &adapter,
        ActionRequest::headless(Action::TypeText("x".into())),
    )
    .unwrap_err();
    assert!(err.message.contains("editable"));
    adapter.0.available_actions.clear();
    for action in [Action::Click, Action::TypeText("x".into())] {
        let err = evaluate(&target, &adapter, ActionRequest::headless(action)).unwrap_err();
        assert!(err.message.contains("supported_action"));
        assert_eq!(err.disposition, crate::DeliverySemantics::not_delivered());
    }
}

#[test]
fn zero_geometry_does_not_relax_live_identity() {
    let (target, adapter) = target("menuitem", &[capability::CLICK]);
    for role in ["unknown", "button"] {
        let mut live = adapter.0.clone();
        live.state.role = role.into();
        let err = evaluate(
            &target,
            &GeometryAdapter(live),
            ActionRequest::headless(Action::Click),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::StaleRef);
    }
    let mut live = adapter.0.clone();
    live.identity = crate::adapter::live_identity("Different item");
    let err = evaluate(
        &target,
        &GeometryAdapter(live),
        ActionRequest::headless(Action::Click),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleRef);
}

#[test]
fn in_window_zero_geometry_still_requires_bounds_headless() {
    let (target, mut adapter) = target("button", &[capability::CLICK]);
    adapter.0.state.offscreen = Some(false);

    let error = evaluate(&target, &adapter, ActionRequest::headless(Action::Click))
        .expect_err("a zero-size control inside a known window is not a closed-menu item");

    assert!(
        error.message.contains("bounds are zero-sized"),
        "{}",
        error.message
    );
}
