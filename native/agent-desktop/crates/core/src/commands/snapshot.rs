use crate::{
    AppError,
    adapter::{PlatformAdapter, SnapshotSurface},
    commands::{wait_selector, wait_selector::WaitSelectorInput},
    context::CommandContext,
    refs::validate_ref_id,
    snapshot,
    snapshot::snapshot_ref,
};
use serde_json::{Value, json};

pub struct SnapshotArgs {
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub max_depth: u8,
    pub include_bounds: bool,
    pub interactive_only: bool,
    pub compact: bool,
    pub surface: SnapshotSurface,
    pub skeleton: bool,
    pub root_ref: Option<String>,
    /// Snapshot deadline in milliseconds. A16-11 measured a cold Chromium
    /// settle at 10-25 s against a hardcoded 3 s deadline, so the caller can
    /// raise it when the post-settle still-thin guidance names
    /// `--timeout-ms`.
    pub timeout_ms: Option<u64>,
    /// Parenthetical spelling the observation-mode sub-struct: the caller says
    /// Chromium accessibility is or will be forced, so the adapter does not
    /// need to guess at guidance. Threaded into the request's observation
    /// mode.
    pub force_electron_a11y: bool,
}

fn tree_options(args: &SnapshotArgs) -> crate::adapter::TreeOptions {
    let skeleton_applies = args.skeleton && args.root_ref.is_none();
    let effective_depth = if skeleton_applies {
        args.max_depth.min(3)
    } else {
        args.max_depth
    };

    crate::adapter::TreeOptions {
        max_depth: effective_depth,
        include_bounds: args.include_bounds,
        interactive_only: args.interactive_only,
        compact: args.compact,
        surface: args.surface,
        skeleton: skeleton_applies,
        force_renderer_accessibility: args.force_electron_a11y,
    }
}

pub fn execute(
    args: SnapshotArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    tracing::debug!(
        max_depth = args.max_depth,
        interactive_only = args.interactive_only,
        compact = args.compact,
        "tree: snapshot"
    );

    if let Some(root) = args.root_ref.as_deref() {
        if context.wait_selector().is_some() {
            return Err(AppError::invalid_input_with_suggestion(
                "--root cannot be combined with --wait-for or --wait-for-gone",
                "Run snapshot without --root, or omit the wait selector flags.",
            ));
        }
        super::surface_scope::reject_root_with_surface("snapshot", Some(root), args.surface)?;
        validate_ref_id(root)?;
    }

    adapter.check_surface_support(args.surface)?;

    let opts = tree_options(&args);

    if let Some(root) = args.root_ref {
        return format_result(snapshot_ref::run_from_ref_with_context(
            adapter,
            &opts,
            &root,
            context,
            args.timeout_ms
                .unwrap_or(snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS),
        )?);
    }

    if let Some(wait) = context.wait_selector() {
        return wait_selector::execute(
            WaitSelectorInput {
                query_raw: wait.query_raw.clone(),
                gone: wait.gone,
                app: args.app.clone(),
                window_id: args.window_id.clone(),
                opts,
                timeout_ms: wait.timeout_ms,
            },
            adapter,
            context,
        );
    }

    let result = snapshot::run_with_context(
        adapter,
        &opts,
        &snapshot::SnapshotTarget {
            app_name: args.app.as_deref(),
            window_id: args.window_id.as_deref(),
        },
        context,
        args.timeout_ms
            .unwrap_or(snapshot::DEFAULT_SNAPSHOT_TIMEOUT_MS),
    )?;

    format_result(result)
}

fn format_result(result: snapshot::SnapshotResult) -> Result<Value, AppError> {
    format_snapshot_fields(&result, None, None)
}

pub(crate) fn format_snapshot_fields(
    result: &snapshot::SnapshotResult,
    elapsed_ms: Option<u128>,
    matched_selector: Option<&str>,
) -> Result<Value, AppError> {
    let ref_count = result.refmap.len();
    let tree = serde_json::to_value(&result.tree)?;
    let win = &result.window;

    tracing::debug!(refs = ref_count, "tree: snapshot complete");

    let mut body = json!({
        "app": win.app,
        "window": {
            "id": win.id,
            "title": win.title
        },
        "ref_count": ref_count,
        "snapshot_id": result.snapshot_id,
        "complete": result.complete,
        "tree": tree
    });
    if !result.complete {
        body["truncated"] = json!(true);
        body["nodes_observed"] = json!(result.nodes_observed);
    }
    if let Some(ms) = elapsed_ms {
        body["elapsed_ms"] = json!(ms);
    }
    if let Some(selector) = matched_selector {
        body["matched_selector"] = json!(selector);
    }
    Ok(body)
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
