//! UIPI elevation detection: a token-integrity comparison, never the
//! `SendInput` verdict. `GetTokenInformation(TokenIntegrityLevel)`
//! reads the caller's own token and, where a target process is named, that
//! process's token; a target strictly higher than the caller maps to
//! `PERM_DENIED` with the `COM HRESULT 0x80070005 (E_ACCESSDENIED: ...)`
//! `platform_detail` format A9-2 already measured.
//!
//! An integrity level this process cannot read is never asserted
//! same-integrity: a blocked write silently no-ops and the caller's re-read
//! judges effect (A9-2), so an unreadable target proceeds best-effort
//! rather than fabricating a verdict. Where both integrity levels are
//! readable and same-or-lower, effect is judged by the ref-addressed leg's
//! post-injection re-read, not by this gate.
//!
//! The live Medium-to-High cross-boundary input *effect* is still
//! unconfirmed, for a narrower reason than the earlier semantic-action pass
//! hit: there, token manufacture itself failed. Here both the probe and the
//! scratch process came up at the same integrity, so there was no
//! strictly-higher target to inject at and the effect was never staged
//! (A20-2, branch `cross_boundary_input_effect_not_staged`). A rig holding
//! two integrity levels at once owns that confirmation. This module proves
//! detection against a real local token read (A20-1) plus synthetic-SID
//! comparison logic, and never asserts the effect.

use agent_desktop_core::{AdapterError, ErrorCode, ProcessId};

use crate::system::runtime::hresult::{E_ACCESSDENIED, com_hresult_detail};

/// The ref-addressed focus-and-integrity gate a physical dispatch leg calls
/// before injecting into a known target process: `Ok` when the target is
/// same-or-lower integrity, or when either integrity level could not be
/// read (best-effort); `Err(PERM_DENIED)` when the target is strictly
/// higher than the caller.
///
/// Bare-coordinate injection has no target process to interrogate, so it
/// never calls this and relies on the re-read/dogfood judgement instead.
pub(crate) fn ensure_target_integrity_allows_input(
    target_pid: ProcessId,
) -> Result<(), AdapterError> {
    evaluate_integrity_gate(
        current_process_integrity_rid(),
        process_integrity_rid(target_pid),
    )
}

/// Caller's mandatory-label RID for integrity comparison outside the input
/// crate (window activation reads the same token facts).
pub(crate) fn current_process_integrity_rid() -> Option<u32> {
    imp::current_process_integrity_rid()
}

/// Target process mandatory-label RID for integrity comparison outside the
/// input crate (window activation reads the same token facts).
pub(crate) fn process_integrity_rid(pid: ProcessId) -> Option<u32> {
    imp::process_integrity_rid(pid)
}

pub(crate) fn evaluate_integrity_gate(
    caller_rid: Option<u32>,
    target_rid: Option<u32>,
) -> Result<(), AdapterError> {
    match (caller_rid, target_rid) {
        (Some(caller), Some(target)) if !integrity_permits_input(caller, target) => {
            Err(elevation_denied_error())
        }
        _ => Ok(()),
    }
}

/// The pure comparison A9-2 maps onto `PERM_DENIED`: a target at or below
/// the caller's mandatory-label RID is permitted, a strictly higher target
/// is not. Takes RIDs rather than SIDs so the decision is testable against
/// synthetic values with no process boundary involved.
pub(crate) fn integrity_permits_input(caller_rid: u32, target_rid: u32) -> bool {
    target_rid <= caller_rid
}

fn elevation_denied_error() -> AdapterError {
    AdapterError::new(
        ErrorCode::PermDenied,
        "The target process runs at a higher integrity level than this process; UIPI blocks input across that boundary",
    )
    .with_platform_detail(com_hresult_detail(E_ACCESSDENIED))
    .with_details(serde_json::json!({
        "raw_input_emitted": false,
    }))
    .with_suggestion(
        "Run agent-desktop at the target's integrity level, or act on an element that does not cross the UIPI boundary",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

/// Activation-worded `PERM_DENIED` when a strictly-higher-integrity target
/// cannot be foregrounded across the UIPI boundary (A21-7 / A9-2). Distinct
/// from [`elevation_denied_error`], which is input-worded.
pub(crate) fn activation_elevation_denied() -> AdapterError {
    AdapterError::new(
        ErrorCode::PermDenied,
        "The target process runs at a higher integrity level than this process; UIPI blocks window activation across that boundary",
    )
    .with_platform_detail(com_hresult_detail(E_ACCESSDENIED))
    .with_details(serde_json::json!({
        "physical_delivery_started": false,
    }))
    .with_suggestion(
        "Run agent-desktop at the target's integrity level, or activate a window that does not cross the UIPI boundary",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::not_delivered())
}

#[cfg(target_os = "windows")]
mod imp {
    use agent_desktop_core::ProcessId;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, PSID,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub(super) fn current_process_integrity_rid() -> Option<u32> {
        token_integrity_rid(unsafe { GetCurrentProcess() })
    }

    pub(super) fn process_integrity_rid(pid: ProcessId) -> Option<u32> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
        if process.is_null() {
            return None;
        }
        let rid = token_integrity_rid(process);
        unsafe { CloseHandle(process) };
        rid
    }

    fn token_integrity_rid(process: HANDLE) -> Option<u32> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let rid = read_token_integrity_rid(token);
        unsafe { CloseHandle(token) };
        rid
    }

    fn read_token_integrity_rid(token: HANDLE) -> Option<u32> {
        let mut required: u32 = 0;
        unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                std::ptr::null_mut(),
                0,
                &mut required,
            );
        }
        if required == 0 {
            return None;
        }
        let mut buffer = vec![0_u64; (required as usize).div_ceil(size_of::<u64>())];
        let fetched = unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        };
        if fetched == 0 {
            return None;
        }
        let label: TOKEN_MANDATORY_LABEL = unsafe { std::ptr::read(buffer.as_ptr().cast()) };
        sid_last_sub_authority(label.Label.Sid)
    }

    /// Extracts the last sub-authority (the mandatory-label RID) from a
    /// SID, `pub(super)` so the synthetic-SID tests can drive it directly
    /// against a `CreateWellKnownSid`-built integrity SID without a
    /// process boundary.
    pub(super) fn sid_last_sub_authority(sid: PSID) -> Option<u32> {
        if sid.is_null() {
            return None;
        }
        let count = unsafe { *GetSidSubAuthorityCount(sid) };
        if count == 0 {
            return None;
        }
        let sub_authority = unsafe { GetSidSubAuthority(sid, u32::from(count - 1)) };
        if sub_authority.is_null() {
            return None;
        }
        Some(unsafe { *sub_authority })
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use agent_desktop_core::ProcessId;

    pub(super) fn current_process_integrity_rid() -> Option<u32> {
        None
    }

    pub(super) fn process_integrity_rid(_pid: ProcessId) -> Option<u32> {
        None
    }
}

#[cfg(test)]
#[path = "elevation_tests.rs"]
mod tests;
