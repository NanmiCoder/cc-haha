use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};

const VERIFY_GRACE_MS: u64 = 1_000;

pub(super) fn not_delivered(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

pub(super) fn unresponsive(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::AppUnresponsive, message)
        .with_disposition(DeliverySemantics::delivered_unverified())
}

/// A deadline of its own for a read-back after the lease deadline may have
/// passed, falling back to `fallback` when none can be made.
pub(super) fn fresh_deadline(fallback: Deadline) -> Deadline {
    Deadline::after(VERIFY_GRACE_MS).unwrap_or(fallback)
}
