use crate::{
    AdapterError, ErrorCode, adapter::PlatformAdapter, context::CommandContext, refs::RefEntry,
};
use serde_json::json;

pub(crate) fn enrich_with_process_state(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    err: AdapterError,
    deadline: crate::Deadline,
) -> AdapterError {
    if !matches!(err.code, ErrorCode::StaleRef | ErrorCode::AppNotFound) {
        return err;
    }
    let Some(instance) = entry
        .process
        .process_instance
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return err;
    };
    let Ok(state) = adapter.process_state(
        crate::ProcessIdentity::new(entry.process.pid, instance),
        deadline,
    ) else {
        return err;
    };
    if state == crate::system::process_state::ProcessState::Unresponsive {
        if !process_identity_matches(adapter, entry, deadline) {
            return err;
        }
        let app = entry
            .source
            .source_app
            .as_deref()
            .unwrap_or("target application");
        let unresponsive = AdapterError::app_unresponsive(app);
        let mut details = match err.details {
            Some(serde_json::Value::Object(details)) => details,
            Some(cause) => serde_json::Map::from_iter([("cause".into(), cause)]),
            None => serde_json::Map::new(),
        };
        details.insert("kind".into(), json!("app_unresponsive"));
        details.insert("retryable".into(), json!(false));
        return unresponsive
            .with_details(details.into())
            .with_disposition(err.disposition);
    }
    attach_process_state_detail(err, state)
}

fn process_identity_matches(
    adapter: &dyn PlatformAdapter,
    entry: &RefEntry,
    deadline: crate::Deadline,
) -> bool {
    let Some(expected_name) = entry
        .source
        .source_app
        .as_deref()
        .filter(|name| !name.is_empty())
    else {
        return false;
    };
    let Some(expected_instance) = entry
        .process
        .process_instance
        .as_deref()
        .filter(|instance| !instance.is_empty())
    else {
        return false;
    };
    let Ok(apps) = adapter.list_apps(deadline) else {
        return false;
    };
    let mut same_pid = apps.iter().filter(|app| app.pid == entry.process.pid);
    let Some(app) = same_pid.next() else {
        return false;
    };
    same_pid.next().is_none()
        && app.name == expected_name
        && app.process_instance.as_deref() == Some(expected_instance)
}

fn attach_process_state_detail(
    err: AdapterError,
    state: crate::system::process_state::ProcessState,
) -> AdapterError {
    let mut details = err.details.clone().unwrap_or_else(|| json!({}));
    match details.as_object_mut() {
        Some(obj) => {
            obj.insert("process_state".into(), json!(state.label()));
        }
        None => details = json!({ "process_state": state.label() }),
    }
    let exited_stale = err.code == ErrorCode::StaleRef
        && matches!(
            state,
            crate::system::process_state::ProcessState::Exited { .. }
        );
    let err = err.with_details(details);
    if exited_stale {
        return err.with_suggestion(EXITED_PROCESS_SUGGESTION);
    }
    err
}

const EXITED_PROCESS_SUGGESTION: &str = "The target process exited. Run 'list-apps' to see \
     whether the application runs again, launch it if it does not, then take a new snapshot";

const PROCESS_STATE_PROBE_BUDGET: std::time::Duration = std::time::Duration::from_secs(1);

pub(crate) fn with_exited_process_state(
    adapter: &dyn PlatformAdapter,
    process: crate::ProcessIdentity,
    err: AdapterError,
    deadline: crate::Deadline,
) -> AdapterError {
    if err.code != ErrorCode::StaleRef {
        return err;
    }
    let probe = deadline.capped(PROCESS_STATE_PROBE_BUDGET);
    match adapter.process_state(process, probe) {
        Ok(state @ crate::system::process_state::ProcessState::Exited { .. }) => {
            attach_process_state_detail(err, state)
        }
        _ => err,
    }
}

pub(crate) fn trace_resolve_error(context: &CommandContext, ref_id: &str, err: &AdapterError) {
    let _ = context.trace_lazy("ref.resolve.error", || {
        json!({
            "ref": ref_id,
            "code": err.code.as_str(),
            "message": err.message.clone(),
            "details": err.details.clone()
        })
    });
}

/// The preparatory scroll moves the view, never the requested action, so a
/// refusal after it writes nothing: the disposition says so, and the
/// `preparatory_scroll` detail records that the view may have changed.
pub(crate) fn after_scroll(mut error: AdapterError) -> AdapterError {
    if error.disposition == crate::DeliverySemantics::Unknown {
        error.disposition = crate::DeliverySemantics::not_delivered();
    }
    let details = error.details.get_or_insert_with(|| json!({}));
    if let Some(details) = details.as_object_mut() {
        details.insert("preparatory_scroll".into(), "may_have_changed_view".into());
    }
    error
}

pub(crate) fn trace_scroll_error(
    target: &crate::ref_action::ref_action_context::RefActionContext<'_>,
    error: &AdapterError,
) {
    let _ = target.context.trace_lazy(
        "ref.scroll_into_view.error",
        || json!({"ref": target.ref_id, "code": error.code.as_str(), "message": error.message}),
    );
}

pub(crate) fn trace_resolve_ok(context: &CommandContext, ref_id: &str) {
    let _ = context.trace_lazy("ref.resolve.ok", || json!({ "ref": ref_id }));
}
