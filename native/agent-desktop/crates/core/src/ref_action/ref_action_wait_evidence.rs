use crate::{ActionRequest, AdapterError};
use serde_json::json;

pub(crate) fn should_scroll_after_preflight(request: &ActionRequest, error: &AdapterError) -> bool {
    request.action.requires_scroll_into_view() && failed_check(error, "visible")
}

/// A failed scroll-into-view recovery must never overwrite the actionability
/// error it was attempting to recover from - the scroll failure is a detail
/// about a rejected recovery attempt, not a replacement diagnosis. This
/// attaches that detail onto the original error's own `details` object
/// (constructing one if the original carried none) rather than discarding
/// either error.
pub(crate) fn attach_scroll_recovery_failure(
    error: AdapterError,
    scroll_error: &AdapterError,
) -> AdapterError {
    let mut details = error.details.clone().unwrap_or_else(|| json!({}));
    let attempt = json!({
        "code": scroll_error.code.as_str(),
        "message": scroll_error.message,
    });
    match details.as_object_mut() {
        Some(object) => {
            object.insert("scroll_into_view_attempted".into(), attempt);
        }
        None => details = json!({ "scroll_into_view_attempted": attempt }),
    }
    error.with_details(details)
}

pub(crate) fn failed_check(error: &AdapterError, check_name: &str) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("checks"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|checks| {
            checks.iter().any(|check| {
                check.get("check").and_then(serde_json::Value::as_str) == Some(check_name)
                    && check.get("status").and_then(serde_json::Value::as_str) == Some("fail")
            })
        })
}

pub(crate) fn observed_bounds_hash(error: &AdapterError) -> Option<u64> {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("observed_bounds_hash"))
        .and_then(serde_json::Value::as_u64)
}
