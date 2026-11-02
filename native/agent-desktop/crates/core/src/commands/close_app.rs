use crate::{AppError, adapter::PlatformAdapter, commands::operation_response::operation_response};
use serde_json::{Value, json};

pub struct CloseAppArgs {
    pub app: String,
    pub force: bool,
}

pub fn execute(args: CloseAppArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    if adapter.is_protected_process(&args.app) {
        return Err(protected_process_error(&args.app));
    }
    let deadline = crate::Deadline::standard()?;
    let expected = crate::commands::helpers::resolve_app(Some(&args.app), adapter, deadline)?;
    let protected = adapter.is_protected_process(&args.app)
        || adapter.is_protected_process(&expected.name)
        || expected
            .bundle_id
            .as_deref()
            .is_some_and(|bundle| adapter.is_protected_process(bundle));
    if protected {
        return Err(protected_process_error(&args.app));
    }
    let lease = adapter.acquire_interaction_lease(deadline)?;
    let live = crate::commands::helpers::revalidate_app_for_mutation(
        adapter,
        &expected,
        lease.deadline(),
    )?;
    let report = adapter.close_app(&live, args.force, &lease)?;
    operation_response(
        &report,
        json!({
            "app": args.app,
            "method": if args.force { "force" } else { "graceful" },
        }),
    )
}

fn protected_process_error(app: &str) -> AppError {
    AppError::invalid_input_with_suggestion(
        format!("'{app}' is a protected system process and cannot be closed"),
        "Target a regular application; session-critical processes are never closed.",
    )
}

#[cfg(test)]
#[path = "close_app_tests.rs"]
mod tests;
