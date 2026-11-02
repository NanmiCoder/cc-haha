//! Write-path classifier for UIA mutation failures.
//!
//! Every Windows write turns its `UiaFailure` into a delivery outcome only
//! through this table. The read-path classifiers
//! (`classify_read_hresult` / `hresult_record` / `uia_failure_disposition`) are
//! unreachable from here by construction and by scan.
//!
//! A19-2 measured the shapes this table must match: `get_pattern` absent is
//! sentinel `0` / `ERR_NONE`; disabled `SetValue` is `0x80040200`
//! (`UIA_E_ELEMENTNOTENABLED`); a killed provider is `0x80040201`
//! (`UIA_E_ELEMENTNOTAVAILABLE`); `0x80131509` (`UIA_E_INVALIDOPERATION`) lands
//! unclassified → uncertain by design.

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use crate::system::runtime::hresult::{
    E_ACCESSDENIED, E_INVALIDARG, RPC_E_DISCONNECTED, RPC_E_SERVERFAULT, RPC_S_CALL_FAILED,
    RPC_S_SERVER_UNAVAILABLE, UIA_E_ELEMENTNOTAVAILABLE, UIA_E_ELEMENTNOTENABLED,
    UIA_E_NOTSUPPORTED, UIA_E_TIMEOUT, com_hresult_detail,
};
use crate::tree::automation::{ERR_NONE, UiaFailure};

/// Maps a successful UIA write onto the delivered mutation outcome.
pub(crate) fn classify_success() -> Result<bool, AdapterError> {
    Ok(true)
}

/// Classifies a failed UIA write into delivered / absent / structured error.
///
/// `Ok(true)` is never produced here — use [`classify_success`] for a clean
/// write. `Ok(false)` means the affordance is genuinely absent and the chain
/// may fall through. `Err` carries the code and disposition for that failure.
pub(crate) fn classify_mutation(
    operation: &str,
    api: &str,
    failure: &UiaFailure,
) -> Result<bool, AdapterError> {
    match *failure {
        UiaFailure::Hresult(hresult) => classify_hresult(operation, api, hresult),
        UiaFailure::Sentinel(sentinel) => classify_sentinel(operation, api, sentinel),
    }
}

/// Classifies a UIA write `Error` for chain fallthrough.
///
/// Sentinel `ERR_NONE` and exhaustion map to absent (`Ok(false)`); every other
/// failure routes through [`classify_mutation`].
#[cfg(target_os = "windows")]
pub(crate) fn classify_write(
    operation: &str,
    api: &str,
    error: &uiautomation::Error,
) -> Result<bool, AdapterError> {
    use crate::tree::automation::failure_of;

    match failure_of(error) {
        UiaFailure::Sentinel(ERR_NONE) => Ok(false),
        other if other.is_exhaustion() => Ok(false),
        failure => classify_mutation(operation, api, &failure),
    }
}

fn classify_hresult(operation: &str, api: &str, hresult: i32) -> Result<bool, AdapterError> {
    if hresult == UIA_E_NOTSUPPORTED {
        return Ok(false);
    }
    if hresult == E_ACCESSDENIED {
        return Err(AdapterError::permission_denied()
            .with_platform_detail(platform_hresult(api, operation, hresult))
            .with_disposition(DeliverySemantics::not_delivered()));
    }
    if hresult == UIA_E_ELEMENTNOTAVAILABLE {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            format!("{operation} targeted an unavailable UI Automation element"),
        )
        .with_platform_detail(platform_hresult(api, operation, hresult))
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion("Refresh the snapshot and retry with the new element reference."));
    }
    if hresult == E_INVALIDARG {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("{operation} rejected an invalid UI Automation argument"),
        )
        .with_platform_detail(platform_hresult(api, operation, hresult))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if hresult == UIA_E_ELEMENTNOTENABLED {
        return Err(AdapterError::new(
            ErrorCode::ActionFailed,
            format!("{operation} targeted an element that is not enabled"),
        )
        .with_platform_detail(platform_hresult(api, operation, hresult))
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    if matches!(
        hresult,
        RPC_E_SERVERFAULT | RPC_E_DISCONNECTED | RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED
    ) {
        return Err(uncertain(
            ErrorCode::AppUnresponsive,
            operation,
            api,
            hresult,
            "transport failure",
        ));
    }
    if hresult == UIA_E_TIMEOUT {
        return Err(uncertain(
            ErrorCode::Timeout,
            operation,
            api,
            hresult,
            "UIA_E_TIMEOUT",
        ));
    }
    Err(uncertain(
        ErrorCode::ActionFailed,
        operation,
        api,
        hresult,
        "unclassified HRESULT",
    ))
}

fn classify_sentinel(operation: &str, api: &str, sentinel: i32) -> Result<bool, AdapterError> {
    if sentinel == ERR_NONE {
        return Ok(false);
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        format!("{operation} returned unclassified sentinel; mutation outcome is uncertain"),
    )
    .with_platform_detail(format!("{api}({operation}) returned sentinel {sentinel}"))
    .with_disposition(DeliverySemantics::uncertain())
    .with_suggestion(
        "Inspect the target state with a fresh snapshot before deciding whether to retry.",
    ))
}

fn uncertain(
    code: ErrorCode,
    operation: &str,
    api: &str,
    hresult: i32,
    label: &str,
) -> AdapterError {
    AdapterError::new(
        code,
        format!("{operation} returned {label}; mutation outcome is uncertain"),
    )
    .with_platform_detail(platform_hresult(api, operation, hresult))
    .with_disposition(DeliverySemantics::uncertain())
    .with_suggestion(
        "Inspect the target state with a fresh snapshot before deciding whether to retry.",
    )
}

fn platform_hresult(api: &str, operation: &str, hresult: i32) -> String {
    format!(
        "{api}({operation}) returned {}",
        com_hresult_detail(hresult)
    )
}

/// The action-file source set every write-path/read-path scan test walks.
/// One list shared by `mutation_tests.rs`, `dispatch_tests.rs`, and
/// `value_write_gate_tests.rs` so a 13th action file needs one edit, not
/// three.
#[cfg(test)]
pub(crate) fn action_scan_sources() -> [(&'static str, &'static str); 12] {
    [
        ("actions/mutation.rs", include_str!("mutation.rs")),
        (
            "actions/scroll_into_view.rs",
            include_str!("scroll_into_view.rs"),
        ),
        ("actions/scroll_ladder.rs", include_str!("scroll_ladder.rs")),
        ("actions/dispatch.rs", include_str!("dispatch.rs")),
        ("actions/focus.rs", include_str!("focus.rs")),
        ("actions/chain.rs", include_str!("chain.rs")),
        ("actions/value_write.rs", include_str!("value_write.rs")),
        ("actions/toggle_state.rs", include_str!("toggle_state.rs")),
        ("actions/disclosure.rs", include_str!("disclosure.rs")),
        ("actions/select.rs", include_str!("select.rs")),
        ("actions/select_search.rs", include_str!("select_search.rs")),
        ("actions/scroll.rs", include_str!("scroll.rs")),
    ]
}

#[cfg(test)]
#[path = "mutation_tests.rs"]
mod tests;
