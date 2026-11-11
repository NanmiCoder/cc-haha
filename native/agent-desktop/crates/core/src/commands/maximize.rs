use crate::{
    AppError, WindowOp,
    adapter::PlatformAdapter,
    commands::helpers::{AppArgs, window_op_command},
};
use serde_json::Value;

pub fn execute(args: AppArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    window_op_command(args, adapter, WindowOp::Maximize)
}
