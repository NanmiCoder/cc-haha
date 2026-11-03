use crate::{AppError, adapter::PlatformAdapter, commands::helpers::resolve_app};
use serde_json::{Value, json};

pub struct ListSurfacesArgs {
    pub app: Option<String>,
}

pub fn execute(args: ListSurfacesArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let app = resolve_app(args.app.as_deref(), adapter, deadline)?;
    let surfaces = adapter
        .list_surfaces(crate::commands::helpers::process_identity(&app)?, deadline)
        .map_err(AppError::Adapter)?;
    Ok(json!({ "pid": app.pid, "surfaces": surfaces }))
}
