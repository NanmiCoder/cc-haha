use agent_desktop_core::AdapterError;

pub(super) fn global_timeout(attempts: u64, last_error: Option<&AdapterError>) -> AdapterError {
    let last = |key: &str| last_error.and_then(|error| error.details.as_ref()?.get(key).cloned());
    let mut details = serde_json::json!({
            "kind": "global_window_inventory_unstable",
            "attempts": attempts,
            "last_code": last_error.map(|error| error.code.as_str()),
            "last_kind": last("kind"),
            "skipped": last("skipped"),
            "last_operation": last("operation"),
            "last_status": last("status"),
            "last_failure_field": last("failure_field"),
            "last_failure_index": last("failure_index"),
            "last_failure_pid": last("failure_pid"),
            "complete": false,
            "retryable": true,
    });
    if let Some(fields) = details.as_object_mut() {
        fields.retain(|_, value| !value.is_null());
    }
    AdapterError::timeout("Global application window inventory did not stabilize before deadline")
        .with_details(details)
}
