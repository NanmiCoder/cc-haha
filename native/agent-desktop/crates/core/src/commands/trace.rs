use crate::{
    AppError,
    context::CommandContext,
    refs::refs_store::RefStore,
    session::resolve_active_session,
    trace::trace_read::{
        ExportOptions, ReadOptions, empty_trace_dir_error, export_html_for_command,
        read_merged_for_command,
    },
};
use serde_json::{Value, json};
use std::path::PathBuf;

const DEFAULT_SHOW_LIMIT: usize = 500;

pub const TRACE_SHOW_DEFAULT_LIMIT: usize = DEFAULT_SHOW_LIMIT;

#[derive(Debug, Clone)]
pub enum TraceAction {
    Show { limit: usize, event: Option<String> },
    Export { limit: usize, out: Option<PathBuf> },
}

pub fn execute(action: TraceAction, context: &CommandContext) -> Result<Value, AppError> {
    match action {
        TraceAction::Show { limit, event } => show(context, limit, event),
        TraceAction::Export { limit, out } => export(context, limit, out),
    }
}

fn resolve_trace_session(context: &CommandContext) -> Result<(String, RefStore), AppError> {
    let session_id = resolve_active_session(context.session_id(), None)?.ok_or_else(|| {
        AppError::invalid_input_with_suggestion(
            "No active session for trace command",
            "Run `session start` or pass `--session <id>`.",
        )
    })?;
    let store = RefStore::for_session(Some(&session_id))?;
    let trace_dir = store.trace_dir();
    if !trace_dir.is_dir() {
        return Err(AppError::invalid_input_with_suggestion(
            format!("Session '{session_id}' has no trace directory"),
            "Run `session start` with tracing enabled before recording commands.",
        ));
    }
    Ok((session_id, store))
}

fn show(context: &CommandContext, limit: usize, event: Option<String>) -> Result<Value, AppError> {
    let (session_id, store) = resolve_trace_session(context)?;
    let trace_dir = store.trace_dir();
    let merged = read_merged_for_command(
        &trace_dir,
        &ReadOptions {
            limit,
            event_prefix: event,
        },
        Some((
            std::process::id(),
            crate::trace::trace_file::process_start_ms(),
            "trace",
        )),
    )?;
    if merged.segments.is_empty() {
        return Err(empty_trace_dir_error(&session_id));
    }

    let mut body = json!({
        "session_id": session_id,
        "segments": merged.segments,
        "total_events": merged.total_events,
        "returned_events": merged.returned_events,
        "truncated": merged.truncated,
        "events": merged.events,
    });

    if let Some(matched_events) = merged.matched_events {
        body["matched_events"] = json!(matched_events);
    }

    if !merged.warnings.is_empty() {
        body["warnings"] = json!(merged.warnings);
    }
    Ok(body)
}

fn export(context: &CommandContext, limit: usize, out: Option<PathBuf>) -> Result<Value, AppError> {
    let (session_id, store) = resolve_trace_session(context)?;
    let (_html, stats) = export_html_for_command(
        &store.trace_dir(),
        &session_id,
        &ExportOptions { limit, out },
        Some((
            std::process::id(),
            crate::trace::trace_file::process_start_ms(),
            "trace",
        )),
    )?;
    let mut body = json!({
        "path": stats.path,
        "event_count": stats.event_count,
        "screenshots_embedded": stats.screenshots_embedded,
        "screenshots_skipped": stats.screenshots_skipped,
        "bytes": stats.bytes,
        "total_events": stats.total_events,
        "returned_events": stats.returned_events,
        "truncated": stats.truncated,
    });
    if !stats.warnings.is_empty() {
        body["warnings"] = json!(stats.warnings);
    }
    Ok(body)
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;
