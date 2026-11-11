use std::time::Duration;

use agent_desktop_core::{AdapterError, Modifier, MouseButton, Point, validate_mouse_click_count};

use crate::input::keyboard::key_plan::{key_down_steps, key_up_steps, modifier_codes};
use crate::input::keyboard::keymap::Keymap;
use crate::input::plan::Plan;
use crate::input::step::Step;

pub(crate) const CLICK_HOLD: Duration = Duration::from_millis(10);
pub(crate) const CLICK_GAP: Duration = Duration::from_millis(20);

pub(crate) const BUTTON_LEFT: u8 = 1;
pub(crate) const BUTTON_MIDDLE: u8 = 2;
pub(crate) const BUTTON_RIGHT: u8 = 3;

pub(crate) fn button_code(button: &MouseButton) -> u8 {
    match button {
        MouseButton::Left => BUTTON_LEFT,
        MouseButton::Middle => BUTTON_MIDDLE,
        MouseButton::Right => BUTTON_RIGHT,
    }
}

pub(crate) fn point_xy(point: &Point) -> Result<(i32, i32), AdapterError> {
    point.validate()?;
    Ok((point.x.round() as i32, point.y.round() as i32))
}

pub(crate) fn pause(duration: Duration) -> Option<Step> {
    (!duration.is_zero()).then_some(Step::Pause(duration))
}

pub(crate) fn plan_move(at: Point) -> Result<Plan, AdapterError> {
    let (x, y) = point_xy(&at)?;
    Ok(Plan {
        steps: vec![Step::MoveTo { x, y }],
        release_origin: None,
    })
}

pub(crate) fn plan_click(
    map: &Keymap,
    at: Point,
    button: &MouseButton,
    count: u32,
    mods: &[Modifier],
) -> Result<Plan, AdapterError> {
    validate_mouse_click_count(count)?;
    let (x, y) = point_xy(&at)?;
    let held = modifier_codes(map, mods)?;
    let code = button_code(button);
    let mut steps = key_down_steps(&held);
    steps.push(Step::MoveTo { x, y });
    for index in 0..count {
        steps.push(Step::Button { code, down: true });
        steps.extend(pause(CLICK_HOLD));
        steps.push(Step::Button { code, down: false });
        if index + 1 < count {
            steps.extend(pause(CLICK_GAP));
        }
    }
    steps.extend(key_up_steps(&held));
    Ok(Plan {
        steps,
        release_origin: Some((x, y)),
    })
}

#[cfg(test)]
#[path = "pointer_plan_tests.rs"]
mod tests;
