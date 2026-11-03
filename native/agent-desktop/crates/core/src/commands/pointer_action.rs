use crate::{
    AppError,
    adapter::PlatformAdapter,
    commands::helpers::{load_ref_entry, resolve_handle_within_deadline},
    context::CommandContext,
    refs::RefEntry,
    refs::ref_resolve_deadline::POLL_INTERVAL,
};
use serde_json::{Value, json};

use crate::actionability::pointer_timeout::point_actionability_timeout;

struct EntryPointResolve<'a> {
    ref_id: &'a str,
    entry: &'a RefEntry,
    stability: Option<Option<u64>>,
    lease: Option<&'a crate::InteractionLease>,
    verify_receives_events: bool,
}

pub(crate) struct PointResolveAttempt<'a> {
    pub args: crate::commands::point_resolve::PointResolveArgs<'a>,
    pub stability: Option<Option<u64>>,
    pub allow_scroll: bool,
}

fn resolve_point_from_entry(
    request: EntryPointResolve<'_>,
    deadline: crate::Deadline,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<crate::commands::point_resolve::ResolvedPoint, AppError> {
    let EntryPointResolve {
        ref_id,
        entry,
        stability,
        lease,
        verify_receives_events,
    } = request;
    let mut handle =
        resolve_handle_within_deadline(adapter, entry, deadline).inspect_err(|err| {
            let _ = context.trace_lazy("ref.resolve.error", || {
                json!({
                    "ref": ref_id,
                    "code": err.code.as_str(),
                    "message": err.message.clone(),
                    "details": err.details.clone()
                })
            });
        })?;
    context.trace_lazy("ref.resolve.ok", || json!({ "ref": ref_id }))?;
    let crate::PointerObservation {
        mut bounds,
        mut states,
    } = adapter.observe_pointer(&handle, deadline)?;
    if !pointer_is_visible(bounds, &states) {
        if deadline.is_expired() {
            return Err(crate::AdapterError::timeout(
                "Pointer target did not become visible within the wait budget",
            )
            .into());
        }
        let Some(lease) = lease else {
            let mut details = json!({ "check": "visible", "requires_scroll": true });
            if let Some(hash) = bounds.and_then(|rect| rect.bounds_hash())
                && let Some(object) = details.as_object_mut()
            {
                object.insert("observed_bounds_hash".into(), json!(hash));
            }
            return Err(crate::AdapterError::new(
                crate::ErrorCode::ActionFailed,
                "Pointer target is not visible in the live accessibility tree",
            )
            .with_details(details)
            .into());
        };
        adapter.scroll_into_view(&handle, lease)?;
        handle = resolve_handle_within_deadline(adapter, entry, deadline)?;
        let observation = adapter.observe_pointer(&handle, deadline)?;
        bounds = observation.bounds;
        states = observation.states;
        if !pointer_is_visible(bounds, &states) {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::ActionFailed,
                "Pointer target is not visible in the live accessibility tree",
            )
            .with_details(json!({ "check": "visible" }))
            .into());
        }
    }
    let Some(bounds) = bounds else {
        return Err(crate::AdapterError::new(
            crate::ErrorCode::ActionFailed,
            format!("Element {ref_id} has no live bounds"),
        )
        .with_details(json!({ "check": "visible" }))
        .into());
    };
    let observed_bounds_hash = bounds.bounds_hash().ok_or_else(|| {
        crate::AdapterError::new(
            crate::ErrorCode::ActionFailed,
            "Pointer target exposes invalid live bounds",
        )
    })?;
    if stability.is_some_and(|expected| expected != Some(observed_bounds_hash)) {
        return Err(crate::AdapterError::new(
            crate::ErrorCode::ActionFailed,
            "Pointer target bounds are not stable yet",
        )
        .with_details(json!({
            "check": "stable",
            "observed_bounds_hash": observed_bounds_hash
        }))
        .into());
    }
    let point = crate::Point {
        x: bounds.x + bounds.width / 2.0,
        y: bounds.y + bounds.height / 2.0,
    };
    if verify_receives_events {
        crate::actionability::require_receives_events(&handle, point.clone(), adapter, deadline)?;
    }
    if deadline.is_expired() {
        return Err(crate::AdapterError::timeout(
            "Pointer target did not become actionable within the wait budget",
        )
        .into());
    }
    Ok(crate::commands::point_resolve::ResolvedPoint {
        point,
        focused: false,
        source_entry: Some(entry.clone()),
        bounds_hash: Some(observed_bounds_hash),
    })
}

fn pointer_is_visible(bounds: Option<crate::Rect>, states: &[String]) -> bool {
    !crate::tree::state::has_state(states, crate::tree::state::HIDDEN)
        && !crate::tree::state::has_state(states, crate::tree::state::OFFSCREEN)
        && bounds.is_some_and(|bounds| {
            bounds.validate().is_ok() && bounds.width > 0.0 && bounds.height > 0.0
        })
}

/// Runs what a pointer gesture does before its first pointer event. Nothing
/// has reached the target by then, so a refusal or a timeout leaves the gesture
/// undelivered whatever the steps before it delivered.
pub(crate) fn before_first_event<T>(
    phase: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    phase().map_err(|error| match error {
        AppError::Adapter(error) => {
            AppError::Adapter(error.with_disposition(crate::DeliverySemantics::not_delivered()))
        }
        other => other,
    })
}

pub(crate) fn point_deadline(timeout_ms: Option<u64>) -> Result<crate::Deadline, AppError> {
    timeout_ms
        .map_or_else(crate::Deadline::standard, crate::Deadline::after)
        .map_err(AppError::Adapter)
}

pub(crate) fn wait_for_point_with_deadline<'a>(
    args: crate::commands::point_resolve::PointResolveArgs<'a>,
    deadline: crate::Deadline,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<crate::commands::point_resolve::ResolvedPoint, AppError> {
    use crate::commands::point_resolve::resolve_point_from_ref_or_xy_with_context;

    let Some(ref_id) = args.ref_id else {
        let lease = crate::InteractionLease::guarded(deadline, ())?;
        return resolve_point_from_ref_or_xy_with_context(args, adapter, context, deadline, &lease);
    };
    let entry = load_ref_entry(ref_id, context)?;
    let mut stability = Some(None);
    let mut last_report = None;
    let mut last_scrolled_bounds_hash = None;
    loop {
        if deadline.is_expired() {
            return Err(point_actionability_timeout(last_report));
        }
        match resolve_point_from_entry(
            EntryPointResolve {
                ref_id,
                entry: &entry,
                stability,
                lease: None,
                verify_receives_events: false,
            },
            deadline,
            adapter,
            context,
        ) {
            Ok(mut point) => {
                point.focused = false;
                return Ok(point);
            }
            Err(err) => {
                let remaining = deadline.remaining();
                if !is_retryable_point_error(&err) {
                    return Err(err);
                }
                last_report = Some(point_error_report(&err));
                if remaining.is_zero() {
                    return Err(point_actionability_timeout(last_report));
                }
                let observed = point_observed_bounds_hash(&err);
                if point_requires_scroll(&err)
                    && !(observed.is_some() && observed == last_scrolled_bounds_hash)
                {
                    scroll_point_target(args, &entry, deadline, adapter, context)?;
                    last_scrolled_bounds_hash = observed;
                    std::thread::sleep(POLL_INTERVAL.min(deadline.remaining()));
                    continue;
                }
                if let Some(observed) = observed {
                    stability = Some(Some(observed));
                }
                let interval = if observed.is_some() {
                    std::time::Duration::from_millis(16)
                } else {
                    POLL_INTERVAL
                };
                std::thread::sleep(interval.min(remaining));
            }
        }
    }
}

pub(crate) fn focus_point_under_lease(
    args: crate::commands::point_resolve::PointResolveArgs<'_>,
    lease: &crate::InteractionLease,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<bool, AppError> {
    if !args.headed_requirement.requires_focus() {
        return Ok(false);
    }
    let Some(ref_id) = args.ref_id else {
        return Ok(false);
    };
    let entry = load_ref_entry(ref_id, context)?;
    crate::commands::point_resolve::focus_for_physical_input(Some(&entry), adapter, context, lease)
}

pub(crate) fn resolve_point_under_lease<'a>(
    attempt: PointResolveAttempt<'a>,
    deadline: crate::Deadline,
    lease: &crate::InteractionLease,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<crate::commands::point_resolve::ResolvedPoint, AppError> {
    use crate::commands::point_resolve::resolve_point_from_ref_or_xy_with_context;

    let PointResolveAttempt {
        args,
        stability,
        allow_scroll,
    } = attempt;
    let Some(ref_id) = args.ref_id else {
        return resolve_point_from_ref_or_xy_with_context(args, adapter, context, deadline, lease);
    };
    let entry = load_ref_entry(ref_id, context)?;
    resolve_point_from_entry(
        EntryPointResolve {
            ref_id,
            entry: &entry,
            stability,
            lease: allow_scroll.then_some(lease),
            verify_receives_events: true,
        },
        deadline,
        adapter,
        context,
    )
}

pub(crate) fn retry_leased_point_phase<T>(
    timeout_ms: Option<u64>,
    deadline: crate::Deadline,
    mut attempt: impl FnMut() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let auto_wait = timeout_ms.is_some_and(|timeout_ms| timeout_ms > 0);
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) if auto_wait && is_retryable_point_error(&error) => {
                let remaining = deadline.remaining();
                if remaining.is_zero() {
                    return Err(point_actionability_timeout(Some(point_error_report(
                        &error,
                    ))));
                }
                std::thread::sleep(POLL_INTERVAL.min(remaining));
            }
            Err(error) => return Err(error),
        }
    }
}

fn scroll_point_target(
    args: crate::commands::point_resolve::PointResolveArgs<'_>,
    entry: &RefEntry,
    deadline: crate::Deadline,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(), AppError> {
    let lease = adapter.acquire_interaction_lease(deadline)?;
    focus_point_under_lease(args, &lease, adapter, context)?;
    let handle = resolve_handle_within_deadline(adapter, entry, deadline)?;
    adapter.scroll_into_view(&handle, &lease)?;
    Ok(())
}

fn point_requires_scroll(err: &AppError) -> bool {
    let AppError::Adapter(error) = err else {
        return false;
    };
    error
        .details
        .as_ref()
        .and_then(|details| details.get("requires_scroll"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn point_error_report(error: &AppError) -> Value {
    json!({
        "code": error.code(),
        "message": error.to_string(),
        "details": match error {
            AppError::Adapter(adapter_error) => adapter_error.details.clone(),
            _ => None,
        }
    })
}

pub(crate) fn ensure_point_deadline(
    deadline: crate::Deadline,
    last_report: Option<Value>,
) -> Result<(), AppError> {
    if deadline.is_expired() {
        return Err(point_actionability_timeout(last_report));
    }
    Ok(())
}

fn point_observed_bounds_hash(err: &AppError) -> Option<u64> {
    let AppError::Adapter(err) = err else {
        return None;
    };
    err.details
        .as_ref()
        .and_then(|details| details.get("observed_bounds_hash"))
        .and_then(Value::as_u64)
}

fn is_retryable_point_error(err: &AppError) -> bool {
    match err {
        AppError::Adapter(error) if error.is_retryable_resolution_failure() => true,
        AppError::Adapter(error) if error.code == crate::ErrorCode::ActionFailed => {
            ["visible", "stable", "receives_events"]
                .into_iter()
                .any(|check| point_failed_check(err, check))
        }
        _ => false,
    }
}

fn point_failed_check(err: &AppError, expected: &str) -> bool {
    let AppError::Adapter(error) = err else {
        return false;
    };
    let Some(details) = error.details.as_ref() else {
        return false;
    };
    if details.get("check").and_then(Value::as_str) == Some(expected) {
        return true;
    }
    details
        .get("checks")
        .and_then(Value::as_array)
        .is_some_and(|checks| {
            checks.iter().any(|check| {
                check.get("check").and_then(Value::as_str) == Some(expected)
                    && check.get("status").and_then(Value::as_str) != Some("pass")
            })
        })
}

#[cfg(test)]
#[path = "pointer_action_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "pointer_single_shot_tests.rs"]
mod single_shot_tests;
