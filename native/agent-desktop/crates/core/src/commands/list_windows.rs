use crate::{
    AppError,
    adapter::{PlatformAdapter, WindowFilter},
};
use serde_json::Value;

pub struct ListWindowsArgs {
    pub app: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub fn execute(args: ListWindowsArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let filter = WindowFilter {
        focused_only: false,
        app: args.app,
    };
    let windows = adapter.list_windows(
        &filter,
        crate::Deadline::after(
            args.timeout_ms
                .unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS),
        )?,
    )?;
    Ok(serde_json::to_value(windows)?)
}
