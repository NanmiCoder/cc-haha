use crate::{AppError, PermissionReport, adapter::PlatformAdapter};
use serde_json::{Value, json};

pub struct PermissionsArgs {
    pub request: bool,
    pub guide: bool,
}

pub fn execute_with_report(
    args: PermissionsArgs,
    adapter: &dyn PlatformAdapter,
    report: &PermissionReport,
) -> Result<Value, AppError> {
    let report = if args.request {
        let lease = crate::commands::helpers::acquire_interaction_lease(adapter)?;
        adapter.request_permissions(&lease)?
    } else {
        report.clone()
    };
    let mut data = json!({
        "accessibility": report.accessibility,
        "screen_recording": report.screen_recording,
        "automation": report.automation
    });
    if args.guide {
        data["guide"] = json!(adapter.start_permission_guide()?);
    }
    Ok(data)
}
