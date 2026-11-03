use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

pub(crate) fn reject_standalone(what: &'static str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("Standalone {what} is unavailable in stateless mode"),
    )
    .with_details(serde_json::json!({
        "raw_input_emitted": false,
        "requires_daemon_owned_transaction": true,
    }))
    .with_suggestion(
        "Use the atomic 'press', 'mouse-click' or 'drag'; spanning holds require a daemon-owned session that can release input after disconnect",
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(test)]
#[path = "standalone_tests.rs"]
mod tests;
