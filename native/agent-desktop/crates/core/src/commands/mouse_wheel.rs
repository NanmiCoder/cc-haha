use crate::{
    AppError, MouseButton, MouseEvent, MouseEventKind, Point, adapter::PlatformAdapter,
    commands::operation_response::operation_response, context::CommandContext,
};
use serde_json::{Value, json};

pub struct MouseWheelArgs {
    pub x: f64,
    pub y: f64,
    pub dy: f64,
    pub dx: f64,
    pub modifiers: Vec<crate::Modifier>,
}

pub fn execute(
    args: MouseWheelArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    crate::commands::point_resolve::require_cursor_policy(context, "mouse-wheel")?;
    crate::commands::point_resolve::require_pointer_capability(adapter)?;
    if !args.x.is_finite() || !args.y.is_finite() || !args.dx.is_finite() || !args.dy.is_finite() {
        return Err(AppError::invalid_input(
            "mouse-wheel coordinates and line deltas must be finite numbers",
        ));
    }
    let _cursor = crate::cursor_overlay::hold_cursor(context, crate::Deadline::standard()?);
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let point = Point {
        x: args.x,
        y: args.y,
    };
    point.validate()?;
    let result = crate::cursor_overlay::dispatch_mouse_event_with_cursor(
        adapter,
        context,
        MouseEvent {
            kind: MouseEventKind::Wheel {
                delta_x: args.dx,
                delta_y: args.dy,
            },
            point,
            button: MouseButton::Left,
            modifiers: args.modifiers,
        },
        false,
        &lease,
    );
    operation_response(&result?, json!({ "dy": args.dy, "dx": args.dx }))
}

#[cfg(test)]
#[path = "mouse_wheel_tests.rs"]
mod tests;
