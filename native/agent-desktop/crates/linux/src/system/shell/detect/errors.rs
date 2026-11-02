use agent_desktop_core::{AdapterError, ErrorCode};
use serde_json::json;

pub(super) fn unreadable(what: &str, why: &str, key: &str) -> AdapterError {
    AdapterError::new(ErrorCode::Timeout, format!("The {what} could not be read"))
        .with_suggestion("Retry the command; report the detail if it persists")
        .with_details(json!({ key: "unreadable", "retryable": true, "detail": why }))
}
