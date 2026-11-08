use crate::{
    AppError,
    adapter::{PlatformAdapter, WindowFilter},
};
use serde_json::{Value, json};
pub struct FocusWindowArgs {
    pub window_id: Option<String>,
    pub app: Option<String>,
    pub title: Option<String>,
}

pub fn execute(args: FocusWindowArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let filter = WindowFilter {
        focused_only: false,
        app: args.app.clone(),
    };
    let windows = adapter.list_windows(&filter, deadline)?;

    let candidates = if let Some(id) = &args.window_id {
        windows
            .into_iter()
            .filter(|window| &window.id == id)
            .collect()
    } else if let Some(title) = &args.title {
        windows
            .into_iter()
            .filter(|window| window.title.contains(title.as_str()))
            .collect()
    } else if args.app.is_some() {
        windows
    } else {
        return Err(AppError::invalid_input(
            "Provide --window-id, --app, or --title to identify the window",
        ));
    };
    let window = crate::system::window_lookup::select_window(
        candidates,
        crate::AdapterError::new(crate::ErrorCode::WindowNotFound, "No matching window found")
            .with_suggestion("Run 'list-windows' to see available windows and their IDs."),
        "More than one window matches the focus target",
    )?;

    let window_id = window.id.clone();
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let focused = crate::system::window_focus::focus_and_confirm(adapter, &window, &lease)?;
    debug_assert_eq!(focused.id, window_id);
    Ok(json!({ "focused": focused }))
}

#[cfg(test)]
#[path = "focus_window_tests.rs"]
mod tests;
