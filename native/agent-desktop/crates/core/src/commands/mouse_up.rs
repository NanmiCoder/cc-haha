use crate::{
    AppError, Modifier, MouseButton,
    adapter::PlatformAdapter,
    commands::point_resolve::{require_cursor_policy, require_pointer_capability},
    context::CommandContext,
};
use serde_json::Value;

pub struct MouseUpArgs {
    pub x: f64,
    pub y: f64,
    pub button: MouseButton,
    pub modifiers: Vec<Modifier>,
}

pub fn execute(
    _args: MouseUpArgs,
    _adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    require_cursor_policy(context, "mouse-up")?;
    require_pointer_capability(_adapter)?;
    Err(crate::commands::input_hold_policy::reject(
        "mouse-up",
        "mouse-click or drag",
    ))
}

#[cfg(test)]
#[path = "mouse_up_tests.rs"]
mod tests;
