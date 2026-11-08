#[cfg(target_os = "macos")]
use agent_desktop_core::refs::ref_identity::has_meaningful_identity;
use agent_desktop_core::{AdapterError, ErrorCode, NativeHandle, RefEntry, SnapshotSurface};
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use super::resolve::resolve_classify::identity_summary_for_message;
#[cfg(target_os = "macos")]
use super::resolve::resolve_read_context::ResolveReadContext;
#[cfg(target_os = "macos")]
use super::resolve::resolve_roots::{candidate_roots, source_window_scope_required};
#[cfg(target_os = "macos")]
use super::resolve::resolve_search::{find_entry_by_path, find_entry_in_roots};

const MAX_RESOLVE_DEPTH: u8 = 50;

#[cfg(target_os = "macos")]
pub(crate) fn resolve_element_with_deadline(
    entry: &RefEntry,
    operation_deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    verify_process_instance(entry)?;
    let deadline = crate::tree::locator_deadline::from_operation(operation_deadline)?;
    let result = retry_incomplete_until(deadline, || resolve_once(entry, deadline));
    match result {
        Err(error) if error.code == ErrorCode::ElementNotFound => {
            Err(stale_ref_error(entry, &error))
        }
        other => other,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_locator_anchor_with_deadline(
    entry: &RefEntry,
    operation_deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    verify_process_instance(entry)?;
    let deadline = crate::tree::locator_deadline::from_operation(operation_deadline)?;
    let result = retry_incomplete_until(deadline, || resolve_locator_anchor_once(entry, deadline));
    match result {
        Err(error) if error.code == ErrorCode::ElementNotFound => {
            Err(stale_ref_error(entry, &error))
        }
        other => other,
    }
}

#[cfg(target_os = "macos")]
fn verify_process_instance(entry: &RefEntry) -> Result<(), AdapterError> {
    super::resolve::retained::validate(entry.identity.retained_object.as_deref())?;
    let Some(instance) = entry.process.process_instance.as_deref() else {
        return Err(AdapterError::stale_ref_because(
            "Saved target has no process instance identity",
        ));
    };
    let pid = crate::system::process::process_identity::to_pid_t(entry.process.pid)?;
    match crate::system::process::process_identity::matches_instance(pid, instance) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AdapterError::stale_ref_because(
            "Saved target belongs to a process instance that is no longer running",
        )),
        Err(error) if error.code == ErrorCode::InvalidArgs => Err(AdapterError::stale_ref_because(
            "Saved target carries a malformed process instance identity",
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn resolve_once(entry: &RefEntry, deadline: Instant) -> Result<NativeHandle, AdapterError> {
    let started = Instant::now();
    crate::tree::locator_deadline::remaining(deadline)?;
    let mut read_context = ResolveReadContext::new(deadline);
    if can_use_path_fast_path(entry) {
        let roots = match candidate_roots(entry, &mut read_context) {
            Ok(roots) => roots,
            Err(error) => {
                return finish_resolution(
                    Err(error),
                    &mut read_context,
                    started,
                    "path_roots",
                    true,
                );
            }
        };
        match find_entry_by_path(&roots.roots, entry, roots.scope_verified, &mut read_context) {
            Ok(handle) => {
                return finish_resolution(
                    Ok(handle),
                    &mut read_context,
                    started,
                    "path_success",
                    true,
                );
            }
            Err(error) if error.code == ErrorCode::ElementNotFound => {
                tracing::debug!(stats = ?read_context.stats, "strict resolution path fast-path fell back to broad search");
            }
            Err(error) => {
                return finish_resolution(
                    Err(error),
                    &mut read_context,
                    started,
                    "path_error",
                    true,
                );
            }
        }
    }
    if !can_use_broad_search(entry) {
        return finish_resolution(
            Err(AdapterError::element_not_found("element")),
            &mut read_context,
            started,
            "identity_insufficient",
            false,
        );
    }
    let roots = match candidate_roots(entry, &mut read_context) {
        Ok(roots) => roots,
        Err(error) => {
            return finish_resolution(Err(error), &mut read_context, started, "broad_roots", false);
        }
    };
    let result = find_entry_in_roots(
        &roots.roots,
        entry,
        MAX_RESOLVE_DEPTH,
        roots.scope_verified,
        &mut read_context,
    );
    finish_resolution(result, &mut read_context, started, "broad_search", false)
}

#[cfg(target_os = "macos")]
fn resolve_locator_anchor_once(
    entry: &RefEntry,
    deadline: Instant,
) -> Result<NativeHandle, AdapterError> {
    let started = Instant::now();
    crate::tree::locator_deadline::remaining(deadline)?;
    let mut read_context = ResolveReadContext::new(deadline);
    if !can_use_locator_anchor_path(entry) {
        return finish_resolution(
            Err(AdapterError::element_not_found("locator anchor")),
            &mut read_context,
            started,
            "locator_anchor_insufficient",
            true,
        );
    }
    let roots = match candidate_roots(entry, &mut read_context) {
        Ok(roots) => roots,
        Err(error) => {
            return finish_resolution(
                Err(error),
                &mut read_context,
                started,
                "locator_anchor_roots",
                true,
            );
        }
    };
    let result = find_entry_by_path(&roots.roots, entry, roots.scope_verified, &mut read_context);
    finish_resolution(
        result,
        &mut read_context,
        started,
        "locator_anchor_path",
        true,
    )
}

#[cfg(target_os = "macos")]
fn finish_resolution<T>(
    result: Result<T, AdapterError>,
    context: &mut ResolveReadContext,
    started: Instant,
    phase: &str,
    path_fast: bool,
) -> Result<T, AdapterError> {
    context.stats.elapsed_us = started.elapsed().as_micros() as u64;
    match result {
        Ok(value) => {
            tracing::debug!(phase, path_fast, stats = ?context.stats, "strict resolution completed");
            Ok(value)
        }
        Err(mut error) => {
            let mut details = error
                .details
                .take()
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(object) = details.as_object_mut() {
                object.insert("resolution_phase".into(), serde_json::json!(phase));
                object.insert("path_fast".into(), serde_json::json!(path_fast));
                object.insert("query_stats".into(), serde_json::json!(&context.stats));
            }
            tracing::debug!(phase, path_fast, code = error.code.as_str(), stats = ?context.stats, "strict resolution failed");
            Err(error.with_details(details))
        }
    }
}

#[cfg(target_os = "macos")]
fn retry_incomplete_until<T>(
    deadline: Instant,
    mut operation: impl FnMut() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    let mut last_incomplete = None;
    loop {
        if let Err(timeout) = crate::tree::locator_deadline::remaining(deadline) {
            return Err(last_incomplete
                .map(mark_deadline_elapsed)
                .unwrap_or(timeout));
        }
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if is_retryable_resolution_error(&error) => {
                last_incomplete = Some(error);
                sleep_before_retry(deadline);
            }
            Err(error) if error.code == ErrorCode::Timeout => match last_incomplete {
                Some(incomplete) => return Err(mark_deadline_elapsed(incomplete)),
                None => return Err(error),
            },
            Err(error) => return Err(error),
        }
    }
}

#[cfg(target_os = "macos")]
fn sleep_before_retry(deadline: Instant) {
    if let Ok(remaining) = crate::tree::locator_deadline::remaining(deadline) {
        std::thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

/// Core owns the payload (`agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed`)
/// so both adapters share one definition.
#[cfg(target_os = "macos")]
use agent_desktop_core::refs::resolve_errors::mark_deadline_elapsed;

#[cfg(target_os = "macos")]
fn stale_ref_error(entry: &RefEntry, cause: &AdapterError) -> AdapterError {
    let retryable = cause.permits_retry_by_default();
    AdapterError::new(
        ErrorCode::StaleRef,
        format!("Element not found: {}", identity_summary_for_message(entry)),
    )
    .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
    .with_details(serde_json::json!({
        "kind": "resolution_complete_absence",
        "complete": true,
        "retryable": retryable,
        "pid": entry.process.pid,
        "source_window_id": entry.source.source_window_id,
        "cause": cause.details,
    }))
}

#[cfg(target_os = "macos")]
fn is_retryable_resolution_error(error: &AdapterError) -> bool {
    error.is_transient_incomplete_read()
}

#[cfg(target_os = "macos")]
fn can_use_path_fast_path(entry: &RefEntry) -> bool {
    let source_scoped = if entry.source.source_surface == SnapshotSurface::Window {
        source_window_scope_required(entry)
    } else {
        true
    };
    source_scoped
        && (entry.scope.root_ref.is_none() || entry.scope.path_is_absolute)
        && !entry.scope.path.is_empty()
        && (entry.geometry.bounds_hash.is_some() || has_meaningful_identity(entry))
}

#[cfg(target_os = "macos")]
fn can_use_locator_anchor_path(entry: &RefEntry) -> bool {
    let source_scoped = if entry.source.source_surface == SnapshotSurface::Window {
        source_window_scope_required(entry)
    } else {
        true
    };
    source_scoped
        && (entry.scope.root_ref.is_none() || entry.scope.path_is_absolute)
        && (entry.geometry.bounds_hash.is_some() || has_meaningful_identity(entry))
}

#[cfg(target_os = "macos")]
fn can_use_broad_search(entry: &RefEntry) -> bool {
    entry.geometry.bounds_hash.is_some() || has_meaningful_identity(entry)
}

pub(crate) mod resolve_ax_read;
pub(super) mod resolve_bounds;
pub(super) mod resolve_classify;
pub(super) mod resolve_errors;
pub(super) mod resolve_read_context;
pub(super) mod resolve_roots;
pub(super) mod resolve_search;
pub(super) mod resolve_source_app;
pub(crate) mod retained;
pub(super) mod retained_store;
#[cfg(test)]
#[path = "resolve_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resolve_tests_more.rs"]
mod tests_more;

#[cfg(not(target_os = "macos"))]
pub(crate) fn resolve_element_with_deadline(
    _entry: &RefEntry,
    _deadline: agent_desktop_core::Deadline,
) -> Result<NativeHandle, AdapterError> {
    Err(AdapterError::not_supported(
        "resolve_element_strict_with_timeout",
    ))
}
