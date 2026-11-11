use crate::{
    AppError, ErrorCode,
    adapter::{PlatformAdapter, TreeOptions},
    commands::{query, snapshot as snapshot_cmd, wait_timeout},
    context::CommandContext,
    locator::live_locator::{
        LocatorMaterialization, LocatorResolveRequest, LocatorSelection, ObservationRoot,
        resolve_query,
    },
    refs::refs_store::RefStore,
    snapshot::{self, emit_snapshot_saved},
    trace::trace_artifacts,
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const DIAGNOSTIC_SNAPSHOT_BUDGET: Duration = Duration::from_millis(600);

pub struct WaitSelectorInput {
    pub query_raw: String,
    pub gone: bool,
    pub app: Option<String>,
    pub window_id: Option<String>,
    pub opts: TreeOptions,
    pub timeout_ms: u64,
}

pub fn execute(
    input: WaitSelectorInput,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let query = query::validate_selector(&input.query_raw)?;

    let start = Instant::now();
    let deadline = crate::Deadline::at(start, input.timeout_ms)?;
    let mut scheduler = super::wait_scheduler::WaitScheduler::new(
        adapter,
        &crate::SignalFilter {
            app: input.app.clone(),
            process: None,
        },
        deadline,
    );
    let mut last_error = None;
    let mut last_built = None;

    loop {
        match observe_selector(adapter, &input, &query, deadline) {
            Ok(Some(true)) if input.gone => {}
            Ok(Some(true)) => match build_materialization(adapter, &input, &query, deadline) {
                Ok((true, result)) => {
                    return materialized_response(
                        result,
                        context,
                        &input,
                        start.elapsed().as_millis(),
                    );
                }
                Ok((false, result)) => last_built = Some(result),
                Err(err) if err.code() == ErrorCode::Timeout.as_str() && deadline.is_expired() => {
                    return timeout_response(
                        adapter,
                        &input,
                        context,
                        last_built,
                        Some(poll_error_json(&err)),
                    );
                }
                Err(err)
                    if err.code() == ErrorCode::Timeout.as_str()
                        || is_transient_poll_error(&err)
                        || is_target_gone_error(&err) =>
                {
                    last_error = Some(poll_error_json(&err));
                }
                Err(err) => return Err(err),
            },
            Ok(Some(false)) if input.gone => {
                return Ok(target_absent_response(
                    &input.query_raw,
                    start.elapsed().as_millis(),
                ));
            }
            Ok(Some(false)) => {}
            Ok(None) => {
                last_error = Some(json!({ "kind": "locator_incomplete" }));
            }
            Err(err) if is_target_gone_error(&err) => {
                if input.gone {
                    return Ok(target_absent_response(
                        &input.query_raw,
                        start.elapsed().as_millis(),
                    ));
                }
                last_error = Some(poll_error_json(&err));
            }
            Err(err) if err.code() == ErrorCode::Timeout.as_str() && deadline.is_expired() => {
                return timeout_response(adapter, &input, context, last_built, last_error);
            }
            Err(err) if err.code() == ErrorCode::Timeout.as_str() => {
                last_error = Some(poll_error_json(&err));
            }
            Err(err) if is_transient_poll_error(&err) => {
                last_error = Some(poll_error_json(&err));
            }
            Err(err) => return Err(err),
        }

        let mut remaining = deadline.remaining();
        if !remaining.is_zero()
            && remaining <= super::wait_scheduler::POLL_INTERVAL
            && last_built.is_none()
        {
            match snapshot::build(
                adapter,
                &input.opts,
                input.app.as_deref(),
                input.window_id.as_deref(),
                deadline,
            ) {
                Ok(result) => last_built = Some(result),
                Err(error) => last_error = Some(poll_error_json(&error)),
            }
            remaining = deadline.remaining();
        }
        if remaining.is_zero() {
            return timeout_response(adapter, &input, context, last_built, last_error);
        }

        scheduler.wait(deadline);
    }
}

fn timeout_response(
    adapter: &dyn PlatformAdapter,
    input: &WaitSelectorInput,
    context: &CommandContext,
    mut last_built: Option<snapshot::SnapshotResult>,
    mut last_error: Option<Value>,
) -> Result<Value, AppError> {
    if last_built.is_none() {
        let diagnostic_deadline =
            crate::Deadline::detached_after(DIAGNOSTIC_SNAPSHOT_BUDGET.as_millis() as u64)?;
        match snapshot::build(
            adapter,
            &input.opts,
            input.app.as_deref(),
            input.window_id.as_deref(),
            diagnostic_deadline,
        ) {
            Ok(result) => last_built = Some(result),
            Err(error) if last_error.is_none() => last_error = Some(poll_error_json(&error)),
            Err(_) => {}
        }
    }
    let snapshot_id = persist_last_built(context, last_built.as_ref())?;
    wait_timeout::selector(
        &input.query_raw,
        input.gone,
        input.timeout_ms,
        last_error,
        snapshot_id,
    )
}

fn persist_last_built(
    context: &CommandContext,
    last_built: Option<&snapshot::SnapshotResult>,
) -> Result<Option<String>, AppError> {
    let Some(result) = last_built else {
        return Ok(None);
    };
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = store.save_new_snapshot_detached(&result.refmap)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &result.refmap)?;
    Ok(Some(snapshot_id))
}

fn observe_selector(
    adapter: &dyn PlatformAdapter,
    input: &WaitSelectorInput,
    query: &crate::LocatorQuery,
    deadline: crate::Deadline,
) -> Result<Option<bool>, AppError> {
    let window = snapshot::resolve_window_for_surface(
        adapter,
        input.app.as_deref(),
        input.window_id.as_deref(),
        input.opts.surface,
        deadline,
    )?;
    let resolution = resolve_query(
        adapter,
        query,
        ObservationRoot::Window(&window),
        &LocatorResolveRequest {
            selection: LocatorSelection::First,
            deadline,
            max_raw_depth: 50,
            surface: (input.opts.surface != crate::SnapshotSurface::Window)
                .then_some(input.opts.surface),
            materialization: LocatorMaterialization::None,
        },
    )?;
    if !resolution.meta.selection_complete {
        return Ok(None);
    }
    Ok(Some(resolution.meta.total_matches > 0))
}

fn build_materialization(
    adapter: &dyn PlatformAdapter,
    input: &WaitSelectorInput,
    query: &crate::LocatorQuery,
    deadline: crate::Deadline,
) -> Result<(bool, snapshot::SnapshotResult), AppError> {
    let result = snapshot::build(
        adapter,
        &input.opts,
        input.app.as_deref(),
        input.window_id.as_deref(),
        deadline,
    )?;
    let matched = query::tree_has_match(&result.tree, query);
    Ok((matched, result))
}

fn materialized_response(
    mut result: snapshot::SnapshotResult,
    context: &CommandContext,
    input: &WaitSelectorInput,
    elapsed_ms: u128,
) -> Result<Value, AppError> {
    let store = RefStore::for_session(context.session_id())?;
    let snapshot_id = store.save_new_snapshot(&result.refmap)?;
    trace_artifacts::copy_refmap_if_full(context, &store, &snapshot_id, &result.refmap)?;
    result.bind_snapshot_id(snapshot_id);
    emit_snapshot_saved(context, &result)?;
    snapshot_cmd::format_snapshot_fields(&result, Some(elapsed_ms), Some(&input.query_raw))
}

fn target_absent_response(query_raw: &str, elapsed_ms: u128) -> Value {
    json!({
        "matched_selector": query_raw,
        "gone": true,
        "target_absent": true,
        "elapsed_ms": elapsed_ms,
    })
}

fn poll_error_json(err: &AppError) -> Value {
    json!({ "code": err.code(), "message": err.to_string() })
}

fn is_target_gone_error(err: &AppError) -> bool {
    matches!(
        err,
        AppError::Adapter(e)
            if matches!(e.code, ErrorCode::AppNotFound | ErrorCode::WindowNotFound)
    )
}

fn is_transient_poll_error(err: &AppError) -> bool {
    matches!(err, AppError::Adapter(error) if error.is_explicitly_retryable())
}

#[cfg(test)]
#[path = "wait_selector_tests.rs"]
mod tests;
