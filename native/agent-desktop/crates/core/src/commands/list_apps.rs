use crate::{AppError, AppInventoryQuery, adapter::PlatformAdapter};
use serde_json::{Value, json};

pub struct ListAppsArgs {
    pub app: Option<String>,
    pub timeout_ms: Option<u64>,
}

pub fn execute(args: ListAppsArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let deadline = crate::Deadline::after(
        args.timeout_ms
            .unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS),
    )?;
    let query = args
        .app
        .as_deref()
        .map_or(AppInventoryQuery::All, AppInventoryQuery::NameOrAlias);
    let inventory = adapter.query_app_inventory(query, deadline)?;
    let mut output = json!({ "apps": inventory.apps });
    if !inventory.skipped.is_empty() {
        output["complete"] = json!(false);
        output["skipped"] = json!(inventory.skipped);
    }
    Ok(output)
}

#[cfg(test)]
#[path = "list_apps_tests.rs"]
mod tests;
