use crate::{
    AppError, WindowOp,
    adapter::PlatformAdapter,
    commands::{
        helpers::{resolve_window_for_app, revalidate_window_for_mutation},
        operation_response::operation_response,
    },
};
use serde_json::{Value, json};

pub struct MoveWindowArgs {
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub x: f64,
    pub y: f64,
}

pub fn execute(args: MoveWindowArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    crate::Point {
        x: args.x,
        y: args.y,
    }
    .validate()?;
    let win = resolve_window_for_app(args.app.as_deref(), args.window_id.as_deref(), adapter)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let live = revalidate_window_for_mutation(adapter, &win, &lease)?;
    let report = adapter.window_op(
        &live,
        WindowOp::Move {
            x: args.x,
            y: args.y,
        },
        &lease,
    )?;
    operation_response(&report, json!({ "x": args.x, "y": args.y }))
}
