use crate::{
    AppError, WindowInfo, WindowOp,
    adapter::{PlatformAdapter, WindowFilter},
    system::window_lookup,
};
use serde_json::{Value, json};

pub struct AppArgs {
    pub app: Option<String>,
    pub window_id: Option<String>,
}

pub(crate) fn window_op_command(
    args: AppArgs,
    adapter: &dyn PlatformAdapter,
    op: WindowOp,
) -> Result<Value, AppError> {
    let deadline = crate::Deadline::standard()?;
    let win = resolve_window(
        args.app.as_deref(),
        args.window_id.as_deref(),
        adapter,
        deadline,
    )?;
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let live = revalidate_window_for_mutation(adapter, &win, &lease)?;
    let report = adapter.window_op(&live, op, &lease)?;
    super::operation_response::operation_response(&report, json!({}))
}

pub(crate) fn resolve_window_for_app(
    app: Option<&str>,
    window_id: Option<&str>,
    adapter: &dyn PlatformAdapter,
) -> Result<WindowInfo, AppError> {
    resolve_window(app, window_id, adapter, crate::Deadline::standard()?)
}

fn resolve_window(
    app: Option<&str>,
    window_id: Option<&str>,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    if let Some(window_id) = window_id {
        let candidates = adapter
            .list_windows(
                &WindowFilter {
                    focused_only: false,
                    app: app.map(str::to_string),
                },
                deadline,
            )?
            .into_iter()
            .filter(|window| window.id == window_id)
            .collect();
        return window_lookup::select_window(
            candidates,
            crate::AdapterError::new(
                crate::ErrorCode::WindowNotFound,
                format!("Window '{window_id}' was not found"),
            )
            .with_suggestion("Run 'list-windows' to refresh window IDs, then retry."),
            "Multiple windows matched the requested window ID",
        );
    }
    let app = super::helpers::resolve_app(app, adapter, deadline)?;
    window_lookup::find_window_for_process(
        super::helpers::process_identity(&app)?,
        adapter,
        deadline,
    )
}

pub(crate) fn revalidate_window_for_mutation(
    adapter: &dyn PlatformAdapter,
    expected: &WindowInfo,
    lease: &crate::InteractionLease,
) -> Result<WindowInfo, AppError> {
    let live = adapter.resolve_window_strict(expected, lease.deadline())?;
    if live.id != expected.id
        || live.pid != expected.pid
        || live.process_instance != expected.process_instance
    {
        return Err(crate::AdapterError::new(
            crate::ErrorCode::StaleRef,
            "Window identity changed before mutation",
        )
        .into());
    }
    Ok(live)
}
