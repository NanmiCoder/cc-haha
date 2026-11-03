use super::Action;
use crate::{
    Direction, DragParams, KeyCombo, Modifier, MouseButton, MouseEvent, MouseEventKind, Point,
    actions::interaction_policy::InteractionPolicy,
};

fn dummy_key() -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers: vec![],
    }
}

fn dummy_drag() -> DragParams {
    DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 1.0, y: 1.0 },
        duration_ms: None,
        drop_delay_ms: None,
    }
}

#[test]
fn action_names_do_not_include_payloads() {
    let cases = [
        (Action::SetValue("private".into()), "set-value"),
        (Action::Select("private".into()), "select"),
        (Action::TypeText("private".into()), "type"),
        (
            Action::PressKey(KeyCombo {
                key: "A".into(),
                modifiers: vec![Modifier::Meta],
            }),
            "press",
        ),
    ];

    for (action, expected) in cases {
        assert_eq!(action.name(), expected);
    }
}

#[test]
fn headed_requirements_distinguish_window_and_pointer_preconditions() {
    for action in [
        Action::Click,
        Action::DoubleClick,
        Action::RightClick,
        Action::TripleClick,
        Action::Scroll(Direction::Down, 1),
        Action::Hover,
        Action::Drag(dummy_drag()),
    ] {
        assert_eq!(
            action.headed_requirement(),
            crate::HeadedRequirement::FocusedWindowAndCursor,
            "{} must require focus plus cursor delivery",
            action.name()
        );
    }
    for action in [
        Action::SetValue("v".into()),
        Action::SetFocus,
        Action::Expand,
        Action::Collapse,
        Action::Select("v".into()),
        Action::Toggle,
        Action::Check,
        Action::Uncheck,
        Action::ScrollTo,
        Action::PressKey(dummy_key()),
        Action::TypeText("v".into()),
        Action::Clear,
    ] {
        assert_eq!(
            action.headed_requirement(),
            crate::HeadedRequirement::FocusedWindow,
            "{} must require focus without pointer movement",
            action.name()
        );
    }
}

#[test]
fn pure_ax_actions_base_policy_is_headless() {
    let headless = InteractionPolicy::headless();
    let pure_ax: &[Action] = &[
        Action::Click,
        Action::DoubleClick,
        Action::RightClick,
        Action::TripleClick,
        Action::SetFocus,
        Action::Expand,
        Action::Collapse,
        Action::Toggle,
        Action::Check,
        Action::Uncheck,
        Action::ScrollTo,
        Action::Clear,
        Action::Scroll(Direction::Down, 3),
        Action::SetValue("v".into()),
        Action::Select("s".into()),
    ];
    for action in pure_ax {
        assert_eq!(
            action.base_interaction_policy(),
            headless,
            "{} must use headless base policy",
            action.name()
        );
    }
}

#[test]
fn type_text_is_headless_but_explicit_press_allows_focus() {
    let headless = InteractionPolicy::headless();
    assert_eq!(
        Action::PressKey(KeyCombo {
            key: "a".into(),
            modifiers: vec![Modifier::Meta],
        })
        .base_interaction_policy(),
        InteractionPolicy::focus_fallback(),
        "PressKey is an explicit physical-input command"
    );
    assert_eq!(
        Action::TypeText("hello".into()).base_interaction_policy(),
        headless,
        "TypeText must not gain implicit focus or keyboard permission"
    );
}

#[test]
fn key_down_and_key_up_base_policy_is_headless_unlike_press_key() {
    let headless = InteractionPolicy::headless();
    assert_eq!(
        Action::KeyDown(dummy_key()).base_interaction_policy(),
        headless,
        "KeyDown must be headless; raw key-down events do not need focus theft"
    );
    assert_eq!(
        Action::KeyUp(dummy_key()).base_interaction_policy(),
        headless,
        "KeyUp must be headless"
    );
}

#[test]
fn hover_and_drag_base_policy_is_headless_independent_of_cursor_requirement() {
    let headless = InteractionPolicy::headless();
    assert_eq!(
        Action::Hover.base_interaction_policy(),
        headless,
        "Hover base_interaction_policy is headless even though requires_cursor_policy is true"
    );
    assert_eq!(
        Action::Drag(dummy_drag()).base_interaction_policy(),
        headless,
        "Drag base_interaction_policy is headless even though requires_cursor_policy is true"
    );
    assert!(
        Action::Hover.requires_cursor_policy(),
        "Hover.requires_cursor_policy() must still be true"
    );
    assert!(
        Action::Drag(dummy_drag()).requires_cursor_policy(),
        "Drag.requires_cursor_policy() must still be true"
    );
}

#[test]
fn requires_hit_test_covers_ref_targeted_pointer_actions() {
    let hit_tested: &[Action] = &[
        Action::Click,
        Action::DoubleClick,
        Action::RightClick,
        Action::TripleClick,
        Action::Hover,
        Action::Drag(dummy_drag()),
    ];
    for action in hit_tested {
        assert!(
            action.requires_hit_test(),
            "{} must require a hit test before dispatch",
            action.name()
        );
    }

    let not_hit_tested: &[Action] = &[
        Action::SetValue("v".into()),
        Action::SetFocus,
        Action::Expand,
        Action::Collapse,
        Action::Select("s".into()),
        Action::Toggle,
        Action::Check,
        Action::Uncheck,
        Action::Scroll(Direction::Down, 1),
        Action::ScrollTo,
        Action::PressKey(dummy_key()),
        Action::KeyDown(dummy_key()),
        Action::KeyUp(dummy_key()),
        Action::TypeText("t".into()),
        Action::Clear,
    ];
    for action in not_hit_tested {
        assert!(
            !action.requires_hit_test(),
            "{} must not require a hit test",
            action.name()
        );
    }
}

#[test]
fn requires_scroll_into_view_covers_all_actions() {
    let scroll_into_view: &[Action] = &[
        Action::Click,
        Action::DoubleClick,
        Action::RightClick,
        Action::TripleClick,
        Action::SetValue("v".into()),
        Action::Expand,
        Action::Collapse,
        Action::Select("s".into()),
        Action::Toggle,
        Action::Check,
        Action::Uncheck,
        Action::TypeText("t".into()),
        Action::Clear,
        Action::Hover,
        Action::Drag(dummy_drag()),
        Action::Scroll(Direction::Down, 1),
    ];
    for action in scroll_into_view {
        assert!(
            action.requires_scroll_into_view(),
            "{} must require scroll-into-view before dispatch",
            action.name()
        );
    }

    let not_scroll_into_view: &[Action] = &[
        Action::ScrollTo,
        Action::SetFocus,
        Action::PressKey(dummy_key()),
        Action::KeyDown(dummy_key()),
        Action::KeyUp(dummy_key()),
    ];
    for action in not_scroll_into_view {
        assert!(
            !action.requires_scroll_into_view(),
            "{} must not require scroll-into-view",
            action.name()
        );
    }
}

/// F10 regression coverage: `MouseEvent.modifiers` must stay `#[serde(default)]`
/// so a legacy payload recorded before modifiers existed (or any FFI/batch
/// caller that omits the key) still deserializes instead of erroring out.
#[test]
fn mouse_event_json_without_modifiers_key_deserializes_to_empty() {
    let event: MouseEvent = serde_json::from_value(serde_json::json!({
        "kind": { "Click": { "count": 1 } },
        "point": { "x": 1.0, "y": 2.0 },
        "button": "Left",
    }))
    .unwrap();

    assert!(event.modifiers.is_empty());
}

#[test]
fn mouse_event_json_with_modifiers_round_trips() {
    let event = MouseEvent {
        kind: MouseEventKind::Click { count: 2 },
        point: Point { x: 1.0, y: 2.0 },
        button: MouseButton::Left,
        modifiers: vec![Modifier::Meta, Modifier::Shift],
    };

    let json = serde_json::to_value(&event).unwrap();
    let round_tripped: MouseEvent = serde_json::from_value(json).unwrap();

    assert_eq!(
        round_tripped.modifiers,
        vec![Modifier::Meta, Modifier::Shift]
    );
}

#[test]
fn modifier_meta_serializes_semantically_and_accepts_legacy_cmd() {
    assert_eq!(serde_json::to_string(&Modifier::Meta).unwrap(), "\"Meta\"");
    assert_eq!(
        serde_json::from_str::<Modifier>("\"Cmd\"").unwrap(),
        Modifier::Meta
    );
}

#[test]
fn wheel_event_round_trips_platform_neutral_line_deltas() {
    let event = MouseEvent {
        kind: MouseEventKind::Wheel {
            delta_x: -2.0,
            delta_y: 3.0,
        },
        point: Point { x: 50.0, y: 60.0 },
        button: MouseButton::Left,
        modifiers: vec![Modifier::Shift],
    };
    let json = serde_json::to_value(&event).unwrap();
    let decoded: MouseEvent = serde_json::from_value(json).unwrap();
    assert!(matches!(
        decoded.kind,
        MouseEventKind::Wheel {
            delta_x: -2.0,
            delta_y: 3.0
        }
    ));
}
