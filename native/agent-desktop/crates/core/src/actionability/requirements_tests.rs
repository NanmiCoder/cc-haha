use super::*;
use crate::{DragParams, KeyCombo, Point};

fn key() -> KeyCombo {
    KeyCombo {
        key: "a".into(),
        modifiers: Vec::new(),
    }
}

#[test]
fn pointer_actions_require_playwright_style_positional_checks() {
    let click = ActionabilityRequirements::for_action(&Action::Click);
    assert!(click.visible && click.stable && click.enabled && click.receives_events);

    let hover = ActionabilityRequirements::for_action(&Action::Hover);
    assert!(hover.visible && hover.stable && hover.receives_events);
    assert!(!hover.enabled);

    let drag = ActionabilityRequirements::for_action(&Action::Drag(DragParams {
        from: Point { x: 0.0, y: 0.0 },
        to: Point { x: 1.0, y: 1.0 },
        duration_ms: None,
        drop_delay_ms: None,
    }));
    assert_eq!(drag, hover);
}

#[test]
fn pointer_delivery_is_selected_from_live_semantic_capability_evidence() {
    let requirements = ActionabilityRequirements::for_action(&Action::Click);

    assert_eq!(
        requirements.pointer_delivery(
            &Action::Click,
            &[crate::actions::capability::CLICK.into()],
            crate::InteractionPolicy::headless(),
        ),
        PointerDelivery::Semantic
    );
    assert_eq!(
        requirements.pointer_delivery(&Action::Click, &[], crate::InteractionPolicy::headless(),),
        PointerDelivery::Physical
    );
    assert_eq!(
        requirements.pointer_delivery(
            &Action::DoubleClick,
            &[crate::actions::capability::CLICK.into()],
            crate::InteractionPolicy::headless(),
        ),
        PointerDelivery::Physical
    );
    assert_eq!(
        requirements.pointer_delivery(
            &Action::Click,
            &[crate::actions::capability::CLICK.into()],
            crate::InteractionPolicy::headed(),
        ),
        PointerDelivery::Physical
    );

    assert!(!requirements.requires_stability(PointerDelivery::Semantic));
    assert!(requirements.requires_stability(PointerDelivery::Physical));
}

#[test]
fn editing_actions_do_not_require_positional_stability_or_hit_testing() {
    let fill = ActionabilityRequirements::for_action(&Action::SetValue("x".into()));
    assert!(fill.visible && fill.enabled && fill.editable);
    assert!(!fill.stable && !fill.receives_events);
}

#[test]
fn keyboard_and_focus_actions_skip_irrelevant_geometry_checks() {
    for action in [
        Action::SetFocus,
        Action::PressKey(key()),
        Action::KeyDown(key()),
        Action::KeyUp(key()),
    ] {
        let requirements = ActionabilityRequirements::for_action(&action);
        assert!(!requirements.visible);
        assert!(!requirements.stable);
        assert!(!requirements.enabled);
        assert!(!requirements.editable);
        assert!(!requirements.receives_events);
    }
}
