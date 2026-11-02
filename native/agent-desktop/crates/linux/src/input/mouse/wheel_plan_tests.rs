use super::*;
use crate::input::step::Step;

fn at() -> Point {
    Point { x: 10.0, y: 20.0 }
}

fn wheel(dx: f64, dy: f64, mods: &[Modifier]) -> Result<Vec<Plan>, AdapterError> {
    plan_wheel(&Keymap::sample(), at(), dx, dy, mods)
}

fn presses(plans: &[Plan], code: u8) -> usize {
    plans
        .iter()
        .flat_map(|plan| &plan.steps)
        .filter(|step| **step == Step::Button { code, down: true })
        .count()
}

fn button_presses(plan: &Plan) -> usize {
    plan.steps
        .iter()
        .filter(|step| matches!(step, Step::Button { down: true, .. }))
        .count()
}

fn first_button(plan: &Plan) -> Option<u8> {
    plan.steps.iter().find_map(|step| match step {
        Step::Button { code, down: true } => Some(*code),
        _ => None,
    })
}

#[test]
fn wheel_safety_and_refusals() {
    let vertical = wheel(0.0, 2.4, &[]).unwrap();
    assert_eq!(presses(&vertical, BUTTON_WHEEL_UP), 2);
    assert_eq!(
        presses(&wheel(0.0, -0.2, &[]).unwrap(), BUTTON_WHEEL_DOWN),
        1
    );
    let horizontal = wheel(3.0, 0.0, &[]).unwrap();
    assert_eq!(presses(&horizontal, BUTTON_WHEEL_RIGHT), 3);
    assert_eq!(
        presses(&wheel(-3.0, 0.0, &[]).unwrap(), BUTTON_WHEEL_LEFT),
        3
    );

    let boundary = wheel(0.0, 11.0, &[Modifier::Ctrl]).unwrap();
    assert_eq!(boundary.len(), 2);
    assert_eq!(presses(&boundary, BUTTON_WHEEL_UP), 11);
    for (plan, count) in boundary.iter().zip([10, 1]) {
        assert_eq!(
            (button_presses(plan), first_button(plan)),
            (count, Some(BUTTON_WHEEL_UP))
        );
        assert_eq!(plan.release_origin, Some((10, 20)));
        assert_eq!(
            (plan.steps.first(), plan.steps.last()),
            (
                Some(&Step::Key {
                    code: 9,
                    down: true
                }),
                Some(&Step::Key {
                    code: 9,
                    down: false
                })
            )
        );
    }

    let both = wheel(2.0, 3.0, &[]).unwrap();
    assert_eq!(both.len(), 2);
    assert_eq!(
        [first_button(&both[0]), first_button(&both[1])],
        [Some(BUTTON_WHEEL_UP), Some(BUTTON_WHEEL_RIGHT)]
    );

    assert_eq!(
        wheel(0.0, 0.0, &[]).unwrap_err().code,
        ErrorCode::InvalidArgs
    );
    for bad in [1001.0, -1001.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for (dx, dy) in [(bad, 0.0), (0.0, bad)] {
            assert_eq!(wheel(dx, dy, &[]).unwrap_err().code, ErrorCode::InvalidArgs);
        }
    }
    assert!(wheel(0.0, 1000.0, &[]).is_ok());
}

#[test]
fn wheel_argument_refusals_are_not_delivered() {
    for (dx, dy) in [(0.0, 0.0), (0.0, -1_000_000.0), (f64::NAN, 1.0)] {
        let error = wheel(dx, dy, &[]).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}
