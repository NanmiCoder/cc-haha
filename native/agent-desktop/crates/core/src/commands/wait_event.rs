use crate::commands::wait_event_filter::{signal_filter, validate_signal_scope};
use crate::{
    AdapterError, AppError, ErrorCode, EventKind, ProcessIdentity, SignalBaseline, UiEvent,
    adapter::PlatformAdapter, commands::wait_event_input::EventWaitInput, diff_signals,
    system::process_state::ProcessState, wait::signals::merge_signal_baseline,
};
use serde_json::{Value, json};
use std::time::Instant;

/// Baseline-diff event wait: captures a `SignalBaseline` at wait start, polls
/// for a fresh one, and matches the first `diff_signals` event whose kind
/// matches the requested `--event` token. `window_id`/`window_title` are
/// optional narrowing filters, never requirements, so a caller who does not
/// yet know a new window's id or title can still wait for it to appear.
pub(crate) fn wait_for_event(
    input: EventWaitInput,
    adapter: &dyn PlatformAdapter,
    seeded_baseline: Option<Result<SignalBaseline, AdapterError>>,
) -> Result<Value, AppError> {
    let requested = parse_event_kind(&input.event)?;
    let start = Instant::now();
    let deadline = crate::Deadline::at(start, input.timeout_ms)?;
    if deadline.is_expired() {
        return timeout_err(
            &input.event,
            input.app.as_ref(),
            input.timeout_ms,
            seeded_baseline.as_ref().and_then(|seed| seed.as_ref().ok()),
            None,
        );
    }
    let filter = match signal_filter(
        &input,
        &requested,
        seeded_baseline.as_ref(),
        adapter,
        deadline,
    ) {
        Ok(filter) => filter,
        Err(AppError::Adapter(err))
            if err.code == ErrorCode::AppNotFound && is_disappearance_class(&requested) =>
        {
            return unresolved_target_result(&requested, input.app.as_deref(), start);
        }
        Err(AppError::Adapter(err)) if crate::commands::wait_timeout::is_deadline_expired(&err) => {
            return timeout_err(
                &input.event,
                input.app.as_ref(),
                input.timeout_ms,
                seeded_baseline.as_ref().and_then(|seed| seed.as_ref().ok()),
                None,
            );
        }
        Err(err) => return Err(err),
    };
    let disappearance = is_disappearance_class(&requested);
    let mut scheduler = super::wait_scheduler::WaitScheduler::new(adapter, &filter, deadline);
    let (mut baseline, mut last_error) = match seeded_baseline {
        Some(Ok(baseline)) => {
            validate_signal_scope(&filter, &baseline)?;
            (Some(baseline), None)
        }
        Some(Err(error)) if is_retryable(&error) => (None, Some(error_evidence(&error))),
        Some(Err(error)) => return Err(AppError::Adapter(error)),
        None => (None, None),
    };
    let mut seen = baseline.clone();

    loop {
        if deadline.is_expired() {
            return timeout_err(
                &input.event,
                input.app.as_ref(),
                input.timeout_ms,
                baseline.as_ref(),
                last_error,
            );
        }

        let observation = adapter.capture_signal_baseline(&filter, deadline);
        if deadline.is_expired() {
            return timeout_err(
                &input.event,
                input.app.as_ref(),
                input.timeout_ms,
                baseline.as_ref(),
                last_error,
            );
        }

        match observation {
            Ok(current) => {
                validate_signal_scope(&filter, &current)?;
                match &baseline {
                    None => {
                        baseline = Some(current.clone());
                        seen = Some(current);
                    }
                    Some(base) => {
                        let diff_base: &SignalBaseline = if disappearance {
                            seen.as_ref().unwrap_or(base)
                        } else {
                            base
                        };
                        let events = diff_signals(diff_base, &current);
                        if let Some(found) = find_match(
                            &events,
                            &requested,
                            input.window_id.as_deref(),
                            input.window_title.as_deref(),
                            filter.process.as_ref().map(|process| process.pid),
                        ) {
                            if confirm_app_terminated(adapter, found, diff_base, deadline) {
                                let elapsed = start.elapsed().as_millis();
                                return Ok(json!({
                                    "found": true,
                                    "event": serde_json::to_value(found)?,
                                    "elapsed_ms": elapsed,
                                }));
                            }
                        }
                        if disappearance {
                            seen = Some(merge_signal_baseline(diff_base, &current));
                        }
                    }
                }
            }
            Err(err) if is_retryable(&err) => {
                last_error = Some(error_evidence(&err));
            }
            Err(err) => return Err(AppError::Adapter(err)),
        }

        let remaining = deadline.remaining();
        if remaining.is_zero() {
            return timeout_err(
                &input.event,
                input.app.as_ref(),
                input.timeout_ms,
                baseline.as_ref(),
                last_error,
            );
        }
        scheduler.wait(deadline);
    }
}

fn is_disappearance_class(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::AppTerminated | EventKind::WindowClosed | EventKind::SurfaceDismissed { .. }
    )
}

fn unresolved_target_result(
    requested: &EventKind,
    app: Option<&str>,
    start: Instant,
) -> Result<Value, AppError> {
    let event = UiEvent {
        kind: requested.clone(),
        window_id: None,
        title: None,
        app: app.map(str::to_string),
        pid: None,
    };
    Ok(json!({
        "found": true,
        "target_unresolved": true,
        "event": serde_json::to_value(event)?,
        "elapsed_ms": start.elapsed().as_millis(),
    }))
}

/// Before a matched `AppTerminated` is reported, corroborates it against
/// `SystemOps::process_state` so a process that only dropped out of the
/// window-owning population (a close-to-tray) is not mistaken for a real
/// exit. Fails open: any ambiguity — no pid on the event, no recoverable
/// `process_instance`, a `not_supported`/errored read, or a non-`AppTerminated`
/// event — reports the event rather than risking a silent no-op that leaves
/// a genuine termination unreported.
fn confirm_app_terminated(
    adapter: &dyn PlatformAdapter,
    event: &UiEvent,
    diff_base: &SignalBaseline,
    deadline: crate::Deadline,
) -> bool {
    if !matches!(event.kind, EventKind::AppTerminated) {
        return true;
    }
    let Some(pid) = event.pid else {
        return true;
    };
    let Some(instance) = diff_base
        .apps
        .iter()
        .find(|app| app.pid == pid)
        .and_then(|app| app.process_instance.clone())
    else {
        return true;
    };
    match adapter.process_state(ProcessIdentity::new(pid, instance), deadline) {
        Ok(ProcessState::Running | ProcessState::Unresponsive) => false,
        Ok(ProcessState::Exited { .. } | ProcessState::Crashed { .. }) | Err(_) => true,
    }
}

fn find_match<'a>(
    events: &'a [UiEvent],
    requested: &EventKind,
    window_id: Option<&str>,
    window_title: Option<&str>,
    pinned_pid: Option<crate::ProcessId>,
) -> Option<&'a UiEvent> {
    events.iter().find(|event| {
        if !requested.same_variant(&event.kind) {
            return false;
        }
        if let Some(pid) = pinned_pid
            && event.pid.is_some_and(|observed| observed != pid)
        {
            return false;
        }
        if let Some(id) = window_id {
            if event.window_id.as_deref() != Some(id) {
                return false;
            }
        }
        if let Some(title) = window_title {
            if !title.is_empty() && event.title.as_deref() != Some(title) {
                return false;
            }
        }
        true
    })
}

/// Whether a capture error is worth polling past: the transient codes, minus
/// the ones that say they settle. An `APP_UNRESPONSIVE` that names a stopped
/// scoped target carries `retryable: false` and ends the wait at once.
fn is_retryable(error: &AdapterError) -> bool {
    matches!(
        error.code,
        ErrorCode::Timeout | ErrorCode::ElementNotFound | ErrorCode::AppUnresponsive
    ) && error.permits_retry_by_default()
}

fn error_evidence(error: &AdapterError) -> Value {
    json!({
        "code": error.code.as_str(),
        "message": error.message,
        "details": error.details,
    })
}

pub(crate) fn parse_event_kind(event: &str) -> Result<EventKind, AppError> {
    EventKind::parse(event).ok_or_else(|| {
        AppError::invalid_input_with_suggestion(
            format!("Unknown --event value: {event}"),
            format!("Use one of: {}", EventKind::all_tokens().join(", ")),
        )
    })
}

fn timeout_err(
    event: &str,
    app: Option<&String>,
    timeout_ms: u64,
    baseline: Option<&SignalBaseline>,
    last_error: Option<Value>,
) -> Result<Value, AppError> {
    let mut details = json!({
        "kind": "wait_timeout",
        "predicate": "event",
        "event": event,
        "app": app,
        "timeout_ms": timeout_ms,
        "baseline_counts": baseline.map(|base| json!({
            "windows": base.windows.len(),
            "apps": base.apps.len(),
            "surfaces": base.surfaces.len(),
        })),
    });
    if let Some(err) = last_error {
        details["last_error"] = err;
    }
    Err(AppError::Adapter(
        AdapterError::timeout(format!(
            "Event '{event}' did not occur within {timeout_ms}ms"
        ))
        .with_details(details),
    ))
}

#[cfg(test)]
#[path = "wait_event_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wait_event_stopped_tests.rs"]
mod stopped_tests;
