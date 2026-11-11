use crate::{
    AppError,
    actions::action_request::ActionRequest,
    adapter::{PlatformAdapter, TreeOptions},
    commands::{wait_selector, wait_selector::WaitSelectorInput},
    context::CommandContext,
    ref_action::ref_action_wait_context::RefActionWaitContext,
    refs::RefEntry,
    refs::refs_store::RefStore,
    system::window_lookup,
};
use serde_json::{Value, json};

pub(crate) use crate::system::app_lookup::{
    process_identity, resolve_app, revalidate_app_for_mutation,
};

pub use super::window_target::AppArgs;
pub(crate) use super::window_target::{
    resolve_window_for_app, revalidate_window_for_mutation, window_op_command,
};

pub struct RefArgs {
    pub ref_id: String,
    pub timeout_ms: Option<u64>,
}

pub(crate) fn acquire_interaction_lease(
    adapter: &dyn PlatformAdapter,
) -> Result<crate::InteractionLease, AppError> {
    Ok(adapter.acquire_interaction_lease(crate::Deadline::standard()?)?)
}

pub fn normalize_action_timeout_ms(raw: u64) -> Option<u64> {
    if raw == 0 { None } else { Some(raw) }
}

pub(crate) fn resolve_ref_with_context(
    ref_id: &str,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(RefEntry, crate::adapter::NativeHandle), AppError> {
    resolve_ref_within_deadline(ref_id, crate::Deadline::standard()?, adapter, context)
}

/// Resolves a saved ref under the caller deadline and records resolution traces.
fn resolve_ref_within_deadline(
    ref_id: &str,
    deadline: crate::Deadline,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<(RefEntry, crate::adapter::NativeHandle), AppError> {
    let entry = load_ref_entry(ref_id, context)?;
    let handle = resolve_handle_within_deadline(adapter, &entry, deadline).inspect_err(|err| {
        let _ = context.trace_lazy("ref.resolve.error", || {
            json!({
                "ref": ref_id,
                "code": err.code.as_str(),
                "message": err.message.clone(),
                "details": err.details.clone()
            })
        });
    })?;
    tracing::debug!("resolve: {} resolved successfully", ref_id);
    context.trace_lazy("ref.resolve.ok", || json!({ "ref": ref_id }))?;
    Ok((entry, handle))
}

/// Gives one-shot resolution its full caller budget; polling paths own their slices.
pub(crate) fn resolve_handle_within_deadline(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    deadline: crate::Deadline,
) -> Result<crate::adapter::NativeHandle, crate::AdapterError> {
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    adapter.resolve_element_strict(entry, deadline)
}

pub(crate) fn execute_ref_action_with_context(
    args: RefArgs,
    adapter: &dyn PlatformAdapter,
    request: ActionRequest,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let request = request.with_timeout_ms(args.timeout_ms);
    validate_post_action_wait(context)?;
    if request.policy.is_headed() && request.action.headed_requirement().requires_cursor() {
        super::point_resolve::require_pointer_capability(adapter)?;
    }
    let entry = load_ref_entry(&args.ref_id, context)?;
    let (result, lease, pre, deadline, lease_started) =
        crate::ref_action::ref_action_wait::execute_with_auto_wait_and_lease(
            RefActionWaitContext {
                adapter,
                entry: &entry,
                ref_id: &args.ref_id,
                context,
            },
            request,
            crate::ref_action::dispatch_resolved,
        )
        .map_err(AppError::Adapter)?;
    let value = serde_json::to_value(result).map_err(|error| {
        post_delivery_error(AppError::Json(error), json!({ "action": "delivered" }))
    })?;
    let lease_hold_ms = u64::try_from(lease_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    drop(lease);
    let mut outcome = apply_post_action_wait(value, Some(&entry), adapter, context);
    update_lease_hold_ms(&mut outcome, lease_hold_ms);
    crate::ref_action::finish_artifacts(
        crate::ref_action::ref_action_context::RefActionContext::new(
            RefActionWaitContext {
                adapter,
                entry: &entry,
                ref_id: &args.ref_id,
                context,
            },
            deadline,
        ),
        &pre,
    );
    outcome
}

pub(crate) fn probe_app_name(adapter: &dyn PlatformAdapter, entry: &RefEntry) -> Option<String> {
    if entry.source.source_app.is_some() {
        return entry.source.source_app.clone();
    }
    let identity = crate::ProcessIdentity::new(
        entry.process.pid,
        entry.process.process_instance.as_deref()?,
    );
    window_lookup::find_window_for_process(identity, adapter, crate::Deadline::standard().ok()?)
        .ok()
        .map(|window| window.app)
}

pub(crate) fn apply_post_action_wait(
    result: Value,
    entry: Option<&RefEntry>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if context.wait_selector().is_none() {
        return Ok(result);
    }
    apply_scoped_post_action_wait(
        result,
        entry.and_then(|entry| probe_app_name(adapter, entry)),
        entry.and_then(|entry| entry.source.source_window_id.clone()),
        adapter,
        context,
    )
}

pub(crate) fn apply_scoped_post_action_wait(
    result: Value,
    app: Option<String>,
    window_id: Option<String>,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let Some(wait) = context.wait_selector() else {
        return Ok(result);
    };
    match wait_selector::execute(
        WaitSelectorInput {
            query_raw: wait.query_raw.clone(),
            gone: wait.gone,
            app,
            window_id,
            opts: TreeOptions::default(),
            timeout_ms: wait.timeout_ms,
        },
        adapter,
        context,
    ) {
        Ok(mut snapshot) => {
            if let Some(body) = snapshot.as_object_mut() {
                body.insert("after_action".into(), result);
            }
            Ok(snapshot)
        }
        Err(AppError::Adapter(mut adapter_err)) => {
            let mut details = adapter_err.details.take().unwrap_or_else(|| json!({}));
            let delivery = super::operation_response::delivery_in(&result);
            if let Some(obj) = details.as_object_mut() {
                obj.insert("after_action".into(), result);
            }
            Err(AppError::Adapter(
                adapter_err.with_details(details).with_disposition(delivery),
            ))
        }
        Err(err) => Err(post_delivery_error(err, result)),
    }
}

fn update_lease_hold_ms(result: &mut Result<Value, AppError>, lease_hold_ms: u64) {
    fn update(value: &mut Value, lease_hold_ms: u64) {
        if let Some(object) = value.as_object_mut() {
            if let Some(auto_wait) = object.get_mut("auto_wait").and_then(Value::as_object_mut) {
                auto_wait.insert("lease_hold_ms".into(), json!(lease_hold_ms));
            }
            for value in object.values_mut() {
                update(value, lease_hold_ms);
            }
        } else if let Some(values) = value.as_array_mut() {
            for value in values {
                update(value, lease_hold_ms);
            }
        }
    }

    match result {
        Ok(value) => update(value, lease_hold_ms),
        Err(AppError::Adapter(error)) => {
            if let Some(details) = &mut error.details {
                update(details, lease_hold_ms);
            }
        }
        Err(_) => {}
    }
}

pub(crate) fn validate_post_action_wait(context: &CommandContext) -> Result<(), AppError> {
    let Some(wait) = context.wait_selector() else {
        return Ok(());
    };
    crate::commands::query::validate_selector(&wait.query_raw)?;
    crate::Deadline::after(wait.timeout_ms)?;
    Ok(())
}

fn post_delivery_error(error: AppError, result: Value) -> AppError {
    let mut adapter_error = match error {
        AppError::Adapter(error) => error,
        other => crate::AdapterError::internal(other.to_string()),
    };
    let mut details = adapter_error.details.take().unwrap_or_else(|| json!({}));
    let delivery = super::operation_response::delivery_in(&result);
    if let Some(object) = details.as_object_mut() {
        object.insert("after_action".into(), result);
    }
    AppError::Adapter(
        adapter_error
            .with_details(details)
            .with_disposition(delivery),
    )
}

#[cfg(test)]
pub(crate) fn execute_ref_action_result_with_context(
    ref_id: &str,
    snapshot_id: Option<&str>,
    adapter: &dyn PlatformAdapter,
    request: ActionRequest,
    context: &CommandContext,
) -> Result<(RefEntry, crate::ActionResult), AppError> {
    let ref_id = &crate::refs::ref_token::qualify_for_test(ref_id, snapshot_id);
    let entry = load_ref_entry(ref_id, context)?;
    let result = crate::ref_action::ref_action_wait::execute_with_auto_wait(
        RefActionWaitContext {
            adapter,
            entry: &entry,
            ref_id,
            context,
        },
        request,
        crate::ref_action::dispatch_resolved,
    )
    .map_err(AppError::Adapter)?;
    Ok((entry, result))
}

/// Shared owner of ref-entry loading and its `ref.resolve.start/entry/error`
/// tracing, used by both the ref-action path
/// ([`execute_ref_action_result_with_context`]) and, via
/// [`resolve_ref_within_deadline`], the pointer/get/is resolve path, so a
/// stale ref emits identical telemetry regardless of caller.
/// [`resolve_ref_within_deadline`] builds handle resolution and the
/// `ref.resolve.ok` event on top of the entry this returns.
pub(crate) fn load_ref_entry(ref_id: &str, context: &CommandContext) -> Result<RefEntry, AppError> {
    let (resolved_snapshot_id, local_ref) = crate::refs::ref_token::resolve_ref_target(ref_id)?;
    let store = RefStore::for_session(context.session_id())?;
    context.trace_lazy(
        "ref.resolve.start",
        || json!({ "ref": ref_id, "snapshot_id": resolved_snapshot_id }),
    )?;
    let refmap = store
        .load_snapshot(&resolved_snapshot_id)
        .inspect_err(|e| {
            tracing::debug!("refmap load failed: {e}");
            let _ = context.trace_lazy("ref.resolve.error", || {
                json!({
                    "ref": ref_id,
                    "snapshot_id": resolved_snapshot_id,
                    "code": e.code(),
                    "message": e.to_string()
                })
            });
        })?;
    let entry = match refmap.get(&local_ref) {
        Some(entry) => entry.clone(),
        None => {
            context.trace_lazy("ref.resolve.error", || {
                json!({
                    "ref": ref_id,
                    "snapshot_id": resolved_snapshot_id,
                    "code": "STALE_REF",
                    "message": "ref not found in current RefMap"
                })
            })?;
            return Err(AppError::stale_ref(ref_id));
        }
    };
    tracing::debug!(
        "resolve: {} -> pid={} role={} name_chars={:?}",
        ref_id,
        entry.process.pid,
        entry.identity.role,
        entry
            .identity
            .name
            .as_deref()
            .map(|name| name.chars().count())
    );
    context.trace_lazy("ref.resolve.entry", || {
        json!({
            "ref": ref_id,
            "pid": entry.process.pid,
            "role": entry.identity.role,
            "name": entry.identity.name
        })
    })?;
    Ok(entry)
}

#[cfg(test)]
#[path = "helpers_test_support.rs"]
pub(super) mod test_support;

#[cfg(test)]
#[path = "helpers_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "helpers_ref_action_dispatch_tests.rs"]
mod ref_action_dispatch_tests;

#[cfg(test)]
#[path = "helpers_ref_action_wait_tests.rs"]
mod ref_action_wait_tests;
