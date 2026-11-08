use std::time::Duration;

use serde_json::json;

use crate::{
    ActionRequest, AdapterError, Deadline, ErrorCode,
    ref_action::ref_action_context::RefActionContext,
    ref_action::ref_action_poll_state::RefActionPollState,
    ref_action::ref_action_wait_context::RefActionWaitContext,
    ref_action::ref_action_wait_evidence::{failed_check, should_scroll_after_preflight},
    ref_action::ref_action_wait_support::{trace_resolve_error, trace_resolve_ok},
    ref_action::{ResolvedRefAction, into_adapter_error, preflight_resolved},
    refs::ref_resolve_deadline::{POLL_INTERVAL, resolve_within_deadline},
    refs::resolve_attempt_outcome::ResolveAttemptOutcome,
};

const STABILITY_POLL_INTERVAL: Duration = Duration::from_millis(16);

/// Waits until the target looks actionable and returns only counters. The
/// resolved handle is deliberately not handed to dispatch: this loop runs
/// *before* the interaction lease is taken, because the lease is a
/// cross-process lock and holding it for the whole wait budget would serialize
/// every agent-desktop process on the machine. Anything resolved here was
/// therefore observed without exclusivity, so dispatch re-resolves under the
/// lease. The second resolve is the correctness boundary, not redundant work.
pub(crate) fn execute_poll_loop(
    context: RefActionWaitContext<'_>,
    request: &ActionRequest,
    deadline: Deadline,
) -> Result<RefActionPollState, AdapterError> {
    let mut state = RefActionPollState {
        expected_bounds_hash: context
            .entry
            .geometry
            .bounds_hash
            .filter(|_| request.policy == crate::InteractionPolicy::headless()),
        ..Default::default()
    };
    loop {
        state.resolve_attempts = state.resolve_attempts.saturating_add(1);
        match resolve_within_deadline(context.adapter, context.entry, deadline) {
            ResolveAttemptOutcome::DeadlinePassed => return Err(timeout(&state, deadline)),
            ResolveAttemptOutcome::Failed(error) => {
                handle_resolve_failure(
                    context,
                    &mut state,
                    crate::ref_action::mark_pre_dispatch_resolution_failure(error),
                    deadline,
                )?;
            }
            ResolveAttemptOutcome::Resolved(handle) => {
                trace_resolve_ok(context.context, context.ref_id);
                state.note_resolved();
                ensure_before_deadline(deadline, &state)?;
                let target =
                    ResolvedRefAction::new(RefActionContext::new(context, deadline), &handle);
                state.preflight_attempts = state.preflight_attempts.saturating_add(1);
                if let Err(error) = preflight_resolved(&target, request, state.stability()) {
                    let error = into_adapter_error(error);
                    let focus_pending = request.headed_requirement().requires_focus()
                        && failed_check(&error, "receives_events");
                    let scroll_can_help = should_scroll_after_preflight(request, &error)
                        && !failed_check(&error, "enabled");
                    if !focus_pending && !scroll_can_help {
                        handle_actionability_failure(&mut state, error, deadline)?;
                        continue;
                    }
                }
                ensure_before_deadline(deadline, &state)?;
                return Ok(state);
            }
        }
    }
}

fn handle_actionability_failure(
    state: &mut RefActionPollState,
    error: AdapterError,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if is_permanent_actionability_error(&error.code) || !error.permits_retry_by_default() {
        return Err(error);
    }
    if error.code == ErrorCode::Timeout && deadline.is_expired() {
        return Err(timeout(state, deadline));
    }
    let stability_changed = failed_check(&error, "stable");
    state.record_preflight_error(&error);
    ensure_before_deadline(deadline, state)?;
    sleep_until_next_poll(
        deadline,
        if stability_changed {
            STABILITY_POLL_INTERVAL
        } else {
            POLL_INTERVAL
        },
    );
    Ok(())
}

fn handle_resolve_failure(
    context: RefActionWaitContext<'_>,
    state: &mut RefActionPollState,
    error: AdapterError,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    if error.code == ErrorCode::StaleRef
        && error
            .details
            .as_ref()
            .and_then(|details| details.get("complete"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        trace_resolve_error(context.context, context.ref_id, &error);
        return Err(error);
    }
    if !error.is_retryable_resolution_failure() {
        trace_resolve_error(context.context, context.ref_id, &error);
        return Err(error);
    }
    state.saw_ambiguity |= error.code == ErrorCode::AmbiguousTarget;
    state.record_resolve_error(&error);
    sleep_until_next_poll(deadline, POLL_INTERVAL);
    Ok(())
}

fn ensure_before_deadline(
    deadline: Deadline,
    state: &RefActionPollState,
) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        return Err(timeout(state, deadline));
    }
    Ok(())
}

fn sleep_until_next_poll(deadline: Deadline, interval: Duration) {
    let remaining = deadline.remaining();
    if !remaining.is_zero() {
        crate::wait::deadline::sleep(interval.min(remaining));
    }
}

fn is_permanent_error(code: &ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::PermDenied
            | ErrorCode::AppNotFound
            | ErrorCode::ActionNotSupported
            | ErrorCode::InvalidArgs
            | ErrorCode::PolicyDenied
            | ErrorCode::Internal
    )
}

fn is_permanent_actionability_error(code: &ErrorCode) -> bool {
    is_permanent_error(code) || matches!(code, ErrorCode::StaleRef | ErrorCode::AmbiguousTarget)
}

fn timeout(state: &RefActionPollState, deadline: Deadline) -> AdapterError {
    if state.only_live_read_incomplete() {
        return live_read_incomplete(state, deadline);
    }
    if let Some(error) = state.settled_identity_error() {
        return settled_identity(error, state, deadline);
    }
    let mut details = json!({
        "kind": "actionability_timeout",
        "timeout_ms": deadline.timeout_ms(),
        "elapsed_ms": deadline.elapsed().as_millis(),
    });
    if let Some(last_report) = state.last_report.clone()
        && let Some(object) = details.as_object_mut()
    {
        object.insert("last_report".into(), last_report);
    }
    if state.saw_ambiguity
        && let Some(object) = details.as_object_mut()
    {
        object.insert("transient_ambiguity".into(), true.into());
    }
    AdapterError::timeout("Target did not become actionable within the wait budget")
        .with_details(details)
        .with_disposition(crate::DeliverySemantics::not_delivered())
}

fn settled_identity(
    error: &AdapterError,
    state: &RefActionPollState,
    deadline: Deadline,
) -> AdapterError {
    let mut settled = error.clone();
    let mut details = settled.details.take().unwrap_or_else(|| json!({}));
    match details.as_object_mut() {
        Some(object) => {
            object.insert("elapsed_ms".into(), json!(deadline.elapsed().as_millis()));
            if state.saw_ambiguity {
                object.insert("transient_ambiguity".into(), true.into());
            }
        }
        None => {
            details = json!({
                "error_details": details,
                "elapsed_ms": deadline.elapsed().as_millis(),
            });
        }
    }
    settled.details = Some(details);
    settled
}

fn live_read_incomplete(state: &RefActionPollState, deadline: Deadline) -> AdapterError {
    let report = state
        .last_report
        .as_ref()
        .and_then(|last| last.get("report"));
    let stats = report.and_then(|report| report.get("query_stats"));
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Live reads were incomplete before actionability could be determined",
    )
    .with_suggestion("Re-snapshot the window and act on a fresh ref once live reads are complete.")
    .with_details(json!({
        "kind": "live_read_incomplete",
        "retryable": false,
        "timeout_ms": deadline.timeout_ms(),
        "elapsed_ms": deadline.elapsed().as_millis(),
        "native_read_failures": stats
            .and_then(|stats| stats.pointer("/reads/native_read_failures"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        "nodes_visited": stats
            .and_then(|stats| stats.pointer("/traversal/nodes_visited"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        "last_report": state.last_report,
    }))
    .with_disposition(crate::DeliverySemantics::not_delivered())
}

#[cfg(test)]
pub(crate) fn timeout_with_last_report(last_report: serde_json::Value) -> AdapterError {
    let deadline = Deadline::after(1).expect("test deadline");
    timeout(
        &RefActionPollState {
            last_report: Some(last_report),
            ..Default::default()
        },
        deadline,
    )
}

#[cfg(test)]
#[path = "ref_action_poll_tests.rs"]
mod tests;
