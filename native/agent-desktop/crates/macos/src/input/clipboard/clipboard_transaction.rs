use super::clipboard_runtime::{Pasteboard, change_count, clear_contents};
use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode};
use std::time::Duration;

pub(super) fn replace_on(
    pasteboard: Pasteboard,
    kind: &str,
    deadline: Deadline,
    write: impl FnOnce(Pasteboard, Deadline) -> Result<bool, AdapterError>,
    verify: impl FnOnce(Pasteboard, Deadline) -> Result<bool, AdapterError>,
) -> Result<(), AdapterError> {
    let mutation_deadline = reserve_cleanup_budget(deadline)?;
    ensure_not_started(mutation_deadline)?;
    let ownership = unsafe { clear_contents(pasteboard) };
    if ownership < 0 {
        return Err(delivery_uncertain(
            kind,
            "clearContents returned an invalid ownership token",
        ));
    }
    if !owns(ownership, unsafe { change_count(pasteboard) }) {
        return Err(delivered_unverified(
            kind,
            "clipboard ownership changed immediately after clearContents",
        ));
    }
    if let Err(error) = ensure_not_started(mutation_deadline) {
        return Err(post_clear_failure(
            pasteboard, ownership, kind, deadline, error,
        ));
    }
    match write(pasteboard, mutation_deadline) {
        Ok(true) => {}
        Ok(false) => {
            return Err(post_clear_failure(
                pasteboard,
                ownership,
                kind,
                deadline,
                AdapterError::new(
                    ErrorCode::ActionFailed,
                    format!("Clipboard {kind} write failed"),
                ),
            ));
        }
        Err(error) => {
            return Err(post_clear_failure(
                pasteboard, ownership, kind, deadline, error,
            ));
        }
    }
    if !owns(ownership, unsafe { change_count(pasteboard) }) {
        return Err(delivered_unverified(
            kind,
            "clipboard ownership changed before verification",
        ));
    }
    let intended = verify(pasteboard, mutation_deadline).map_err(|error| {
        delivered_unverified(kind, &format!("content verification failed: {error}"))
    })?;
    if !owns(ownership, unsafe { change_count(pasteboard) }) {
        return Err(delivered_unverified(
            kind,
            "clipboard ownership changed during verification",
        ));
    }
    if !intended {
        return Err(post_clear_failure(
            pasteboard,
            ownership,
            kind,
            deadline,
            AdapterError::new(
                ErrorCode::ActionFailed,
                format!("Clipboard {kind} did not retain the intended content"),
            ),
        ));
    }
    ensure_verified_before_return(deadline)
}

pub(super) fn clear_verified(
    pasteboard: Pasteboard,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    ensure_not_started(deadline)?;
    let ownership = unsafe { clear_contents(pasteboard) };
    if ownership < 0 || !owns(ownership, unsafe { change_count(pasteboard) }) {
        return Err(delivery_uncertain(
            "clear",
            "clipboard ownership could not be verified",
        ));
    }
    ensure_verified_before_return(deadline)
}

fn post_clear_failure(
    pasteboard: Pasteboard,
    ownership: isize,
    kind: &str,
    deadline: Deadline,
    cause: AdapterError,
) -> AdapterError {
    match clear_if_owned(pasteboard, ownership, deadline) {
        Ok(cleaned) => AdapterError::new(
            cause.code.clone(),
            format!("Clipboard {kind} replacement failed after clearing prior content"),
        )
        .with_platform_detail(cause.to_string())
        .with_details(serde_json::json!({
            "cleanup_verified": cleaned,
            "concurrent_change": !cleaned,
        }))
        .with_disposition(DeliverySemantics::delivered_unverified()),
        Err(cleanup_error) => {
            delivery_uncertain(kind, &format!("{cause}; cleanup failed: {cleanup_error}"))
        }
    }
}

fn clear_if_owned(
    pasteboard: Pasteboard,
    ownership: isize,
    deadline: Deadline,
) -> Result<bool, AdapterError> {
    if !owns(ownership, unsafe { change_count(pasteboard) }) {
        return Ok(false);
    }
    ensure_not_started(deadline)?;
    let cleanup_ownership = unsafe { clear_contents(pasteboard) };
    if cleanup_ownership < 0 || !owns(cleanup_ownership, unsafe { change_count(pasteboard) }) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Clipboard cleanup could not be verified",
        ));
    }
    Ok(true)
}

fn reserve_cleanup_budget(deadline: Deadline) -> Result<Deadline, AdapterError> {
    let remaining = deadline.remaining();
    if remaining <= Duration::from_millis(2) {
        return Err(deadline
            .timeout_error()
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    let reserve = (remaining / 2).min(Duration::from_millis(250));
    Deadline::from_duration(remaining.saturating_sub(reserve))
}

fn owns(ownership: isize, current: isize) -> bool {
    ownership >= 0 && ownership == current
}

fn ensure_not_started(deadline: Deadline) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        Err(deadline
            .timeout_error()
            .with_disposition(DeliverySemantics::not_delivered()))
    } else {
        Ok(())
    }
}

fn ensure_verified_before_return(deadline: Deadline) -> Result<(), AdapterError> {
    if deadline.is_expired() {
        Err(deadline
            .timeout_error()
            .with_disposition(DeliverySemantics::delivered_verified()))
    } else {
        Ok(())
    }
}

fn delivered_unverified(kind: &str, reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("Clipboard {kind} delivery could not be verified"),
    )
    .with_platform_detail(reason)
    .with_suggestion("Inspect the clipboard state before deciding whether to repeat the write")
    .with_disposition(DeliverySemantics::delivered_unverified())
}

fn delivery_uncertain(kind: &str, reason: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("Clipboard {kind} delivery is uncertain"),
    )
    .with_platform_detail(reason)
    .with_suggestion("Inspect the clipboard state before deciding whether to repeat the write")
    .with_disposition(DeliverySemantics::uncertain())
}

#[cfg(test)]
#[path = "clipboard_transaction_tests.rs"]
mod tests;
