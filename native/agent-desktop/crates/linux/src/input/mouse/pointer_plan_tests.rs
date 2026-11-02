use super::*;
use agent_desktop_core::ErrorCode;

fn at() -> Point {
    Point { x: 100.4, y: 200.6 }
}

fn click(count: u32, mods: &[Modifier]) -> Result<Plan, AdapterError> {
    plan_click(&Keymap::sample(), at(), &MouseButton::Left, count, mods)
}

#[test]
fn click_safety_and_refusals() {
    let plan = click(2, &[Modifier::Ctrl, Modifier::Shift]).unwrap();
    let key = |code, down| Step::Key { code, down };
    let button = |down| Step::Button {
        code: BUTTON_LEFT,
        down,
    };
    assert_eq!(
        &plan.steps[..3],
        &[key(9, true), key(8, true), Step::MoveTo { x: 100, y: 201 }]
    );
    assert_eq!(
        &plan.steps[3..7],
        &[
            button(true),
            Step::Pause(CLICK_HOLD),
            button(false),
            Step::Pause(CLICK_GAP)
        ]
    );
    assert_eq!(
        &plan.steps[7..],
        &[
            button(true),
            Step::Pause(CLICK_HOLD),
            button(false),
            key(8, false),
            key(9, false)
        ]
    );
    assert_eq!(plan.release_origin, Some((100, 201)));
    for count in [0, agent_desktop_core::MAX_MOUSE_CLICK_COUNT + 1] {
        assert_eq!(click(count, &[]).unwrap_err().code, ErrorCode::InvalidArgs);
    }
    assert!(click(agent_desktop_core::MAX_MOUSE_CLICK_COUNT, &[]).is_ok());
    assert_eq!(
        plan_click(
            &Keymap::sample(),
            Point {
                x: f64::NAN,
                y: 0.0
            },
            &MouseButton::Left,
            1,
            &[]
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidArgs
    );
    let bare = Keymap::new(8, 2, vec![1, 2], 0, Vec::new());
    let error = plan_click(&bare, at(), &MouseButton::Left, 1, &[Modifier::Ctrl]).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
}
