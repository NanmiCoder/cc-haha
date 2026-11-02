use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode, RefEntry};

pub(in crate::tree) fn native_identifier_role_reuse(entry: &RefEntry) -> AdapterError {
    AdapterError::new(
        ErrorCode::StaleRef,
        "Saved native identifier was found only on a different accessibility role",
    )
    .with_suggestion("Run 'snapshot' to refresh, then retry with the updated ref.")
    .with_disposition(DeliverySemantics::not_delivered())
    .with_details(serde_json::json!({
        "kind": "native_identifier_role_reuse",
        "expected_role": entry.identity.role,
        "complete": true,
        "retryable": false,
    }))
}

/// Core owns the payload (`agent_desktop_core::refs::resolve_errors::identity_unknown_error`)
/// so both adapters share one definition: an unreadable candidate
/// means the same thing whichever adapter's search produced it.
pub(in crate::tree) use agent_desktop_core::refs::resolve_errors::identity_unknown_error as identity_unknown;

pub(in crate::tree) fn incomplete_traversal(phase: &str, depth: u8) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!(
            "Strict element resolution observed an incomplete accessibility tree during {phase}"
        ),
    )
    .with_suggestion("Retry after the target application finishes updating its accessibility tree")
    .with_details(serde_json::json!({
        "kind": "resolution_traversal_incomplete",
        "phase": phase,
        "depth": depth,
        "complete": false,
        "retryable": true,
    }))
}
