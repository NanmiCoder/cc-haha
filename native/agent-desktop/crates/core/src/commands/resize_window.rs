use crate::{
    AppError, WindowOp,
    adapter::PlatformAdapter,
    commands::{
        helpers::{resolve_window_for_app, revalidate_window_for_mutation},
        operation_response::operation_response,
    },
};
use serde_json::{Value, json};

pub struct ResizeWindowArgs {
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub width: f64,
    pub height: f64,
}

pub fn execute(args: ResizeWindowArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    crate::Rect {
        x: 0.0,
        y: 0.0,
        width: args.width,
        height: args.height,
    }
    .validate()?;
    let win = resolve_window_for_app(args.app.as_deref(), args.window_id.as_deref(), adapter)?;
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let live = revalidate_window_for_mutation(adapter, &win, &lease)?;
    let report = adapter.window_op(
        &live,
        WindowOp::Resize {
            width: args.width,
            height: args.height,
        },
        &lease,
    )?;
    operation_response(
        &report,
        json!({ "width": args.width, "height": args.height }),
    )
}
