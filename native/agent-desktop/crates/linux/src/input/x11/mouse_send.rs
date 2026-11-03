use agent_desktop_core::{AdapterError, InteractionLease, MouseEvent, MouseEventKind};

use super::session;
use crate::input::mouse::pointer_plan::{plan_click, plan_move};
use crate::input::mouse::wheel_plan::plan_wheel;
use crate::input::plan::Plan;
use crate::input::standalone::reject_standalone;

pub(crate) fn plans_for(
    display: &str,
    event: &MouseEvent,
    lease: &InteractionLease,
) -> Result<Vec<Plan>, AdapterError> {
    let map = if event.modifiers.is_empty() {
        Default::default()
    } else {
        session::live_keymap(display, lease)?
    };
    match &event.kind {
        MouseEventKind::Move => plan_move(event.point.clone()).map(|plan| vec![plan]),
        MouseEventKind::Click { count } => plan_click(
            &map,
            event.point.clone(),
            &event.button,
            *count,
            &event.modifiers,
        )
        .map(|plan| vec![plan]),
        MouseEventKind::Wheel { delta_x, delta_y } => plan_wheel(
            &map,
            event.point.clone(),
            *delta_x,
            *delta_y,
            &event.modifiers,
        ),
        MouseEventKind::Down => Err(reject_standalone("mouse_event down")),
        MouseEventKind::Up => Err(reject_standalone("mouse_event up")),
    }
}
