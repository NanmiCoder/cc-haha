use crate::{AppError, adapter::PlatformAdapter, commands::operation_response::operation_response};
use serde_json::{Value, json};

pub fn execute(adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
    let report = adapter.clear_clipboard(&lease)?;
    operation_response(&report, json!({}))
}
