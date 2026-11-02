use agent_desktop_core::{AdapterError, ErrorCode};
use serde_json::json;

pub(crate) fn semantic_read(error: i32, phase: &str) -> AdapterError {
    let details = json!({ "ax_error": error, "kind": "observation_semantic_read", "phase": phase });
    if error == accessibility_sys::kAXErrorAPIDisabled {
        return AdapterError::new(
            ErrorCode::PermDenied,
            "Accessibility API was disabled during observation",
        )
        .with_suggestion("Grant Accessibility permission, then retry")
        .with_details(details);
    }
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Accessibility evidence read did not complete",
    )
    .with_suggestion("Retry within the existing operation deadline")
    .with_details(json!({
        "ax_error": error,
        "complete": false,
        "kind": "observation_semantic_read",
        "phase": phase,
        "retryable": true,
    }))
}
