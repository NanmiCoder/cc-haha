use std::time::Duration;

use agent_desktop_core::{
    AdapterError, DeliverySemantics, ErrorCode, InteractionLease, WindowInfo,
};

#[cfg(target_os = "windows")]
use crate::system::runtime::hresult;

use crate::input::elevation::{
    activation_elevation_denied, current_process_integrity_rid, process_integrity_rid,
};

use super::window_identity::WindowIdentityEvidence;
use super::window_ops::{is_foreground_window, parse_handle};

/// A21-6: the committed capture recorded 0/5 first-attempt successes, and
/// the scratch-window foreground transition did not land on the second
/// attempt either; the repo-controlled scratch host cannot stage the
/// contention this retry exists to survive, so that case was never
/// exercised here. A budget still has to be finite regardless of what this
/// host could measure: an unbounded retry against a target that truly
/// never becomes foreground would hang the caller instead of failing
/// closed. Two keeps the one extra attach-and-set-foreground attempt after
/// a short delay, enough for a retry to observe an attach the first
/// attempt raced, then exhausts and fails closed rather than asserting a
/// success rate this capture never showed.
const FOCUS_STEAL_BUDGET: u32 = 2;
const INTER_ATTEMPT_DELAY: Duration = Duration::from_millis(25);

/// Raises and focuses the exact window after stored-identity verification.
///
/// A handle destroyed and recycled to another process after selection can
/// never be restored, foregrounded, or reported as focused. Check-then-act
/// on an HWND cannot be made atomic, so ownership is enforced on both sides
/// of every write rather than once at entry: the stored pid and process
/// generation are verified here, each native write re-reads the owning pid
/// immediately before issuing it, and success itself is ownership-qualified:
/// `is_owned_foreground` requires the foreground window to be this handle
/// **and** still owned by the expected process. A recycle that wins the
/// residual race therefore fails closed as not-delivered instead of
/// reporting focus over a foreign window and licensing headed input into it.
///
/// Restore-versus-raise ordering: restore-then-raise when iconic; raise
/// without restore when visible-but-not-foreground. Cross-integrity targets
/// are attempt-and-verify (A21-7); budget exhaustion on a strictly-higher
/// integrity target is activation-worded `PERM_DENIED`, otherwise
/// `ACTION_FAILED` with `physical_delivery_started: false`.
pub(crate) fn focus_window(win: &WindowInfo, lease: &InteractionLease) -> Result<(), AdapterError> {
    lease
        .deadline()
        .ensure_remaining()
        .map_err(before_activation)?;
    let handle = parse_handle(&win.id);
    if handle.is_null() {
        return Err(before_activation(AdapterError::new(
            ErrorCode::InvalidArgs,
            "window id is not a Windows HWND-shaped id",
        )));
    }
    let Some(evidence) = WindowIdentityEvidence::from_info(handle, win) else {
        return Err(before_activation(AdapterError::new(
            ErrorCode::StaleRef,
            "headed focus requires a process-instance token on the stored window",
        )));
    };
    evidence.verify_stored().map_err(before_activation)?;
    ensure_window_is_pumping(handle).map_err(before_activation)?;
    restore_if_iconic(handle, &evidence).map_err(before_activation)?;
    if is_owned_foreground(handle, &evidence) {
        return Ok(());
    }
    let strictly_higher = activation_target_is_strictly_higher(win.pid);
    raise_with_budget(handle, &evidence, lease, strictly_higher)
}

fn before_activation(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

/// Refuses activation of a target that is not dispatching messages.
///
/// This conservative liveness check runs after identity verification and
/// before activation. Restore/show use asynchronous window calls, while
/// `SetForegroundWindow` can still be refused by Windows; checking after
/// verification keeps a destroyed or recycled handle classified as stale.
#[cfg(target_os = "windows")]
fn ensure_window_is_pumping(handle: super::window_enum::WindowHandle) -> Result<(), AdapterError> {
    if super::window_enum::window_is_responsive(handle) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Target window is not processing messages, so activation would block",
    )
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_suggestion("Wait for the application to recover before retrying headed input"))
}

#[cfg(not(target_os = "windows"))]
fn ensure_window_is_pumping(_handle: super::window_enum::WindowHandle) -> Result<(), AdapterError> {
    Ok(())
}

fn activation_target_is_strictly_higher(pid: agent_desktop_core::ProcessId) -> bool {
    #[cfg(all(test, target_os = "windows"))]
    if force_strictly_higher::is_active() {
        return true;
    }
    integrity_is_strictly_higher(current_process_integrity_rid(), process_integrity_rid(pid))
}

/// Pure integrity comparison for activation policy: a readable, strictly
/// higher target RID is the cross-integrity branch (A21-7). Unreadable sides
/// are best-effort, matching the input gate.
pub(crate) fn integrity_is_strictly_higher(
    caller_rid: Option<u32>,
    target_rid: Option<u32>,
) -> bool {
    matches!((caller_rid, target_rid), (Some(caller), Some(target)) if target > caller)
}

fn raise_with_budget(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
    lease: &InteractionLease,
    strictly_higher: bool,
) -> Result<(), AdapterError> {
    for attempt in 0..FOCUS_STEAL_BUDGET {
        if attempt == 0 {
            lease
                .deadline()
                .ensure_remaining()
                .map_err(before_activation)?;
        } else {
            lease
                .deadline()
                .ensure_remaining()
                .map_err(after_foreground_write_attempted)?;
            std::thread::sleep(INTER_ATTEMPT_DELAY);
            lease
                .deadline()
                .ensure_remaining()
                .map_err(after_foreground_write_attempted)?;
        }
        #[cfg(test)]
        attempt_probe::begin_attempt(attempt);
        bring_to_foreground(handle, evidence)?;
        if is_owned_foreground(handle, evidence) {
            return Ok(());
        }
    }
    Err(budget_exhausted(strictly_higher))
}

/// A lease can expire between budget-loop attempts as well as before the
/// first one, and the two are different delivery claims, not the same
/// timeout twice. Before this loop's first `bring_to_foreground` call the
/// window has not been touched, so that timeout is routed through
/// `before_activation` like every pre-write failure above it. From the
/// second attempt onward, a prior `bring_to_foreground` call has already
/// issued `ShowWindow`/`SetForegroundWindow` against the live handle, so the
/// envelope cannot claim nothing was written even though the error itself is
/// a plain `Timeout`. That mirrors the split the keyboard and mouse release
/// guards already use: not-delivered while nothing has gone out,
/// delivered-unverified once a physical write has.
fn after_foreground_write_attempted(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

pub(crate) fn budget_exhausted(strictly_higher: bool) -> AdapterError {
    if strictly_higher {
        activation_elevation_denied()
    } else {
        AdapterError::new(
            ErrorCode::ActionFailed,
            "Target window did not become foreground before headed delivery",
        )
        .with_details(serde_json::json!({
            "physical_delivery_started": false,
        }))
        .with_suggestion("Retry after ensuring the target window can accept focus")
        .with_disposition(DeliverySemantics::not_delivered())
    }
}

/// Whether the handle is the foreground window **and** is still owned by the
/// stored process instance.
///
/// Handle equality alone would accept a recycled HWND; pid equality alone
/// would accept a replacement process that inherited a recycled pid. The
/// success predicate therefore asks the same full-identity question the
/// admission check asks, and an unreadable answer is not a success — a
/// generation read that fails leaves the window unproven, so this reports
/// false and the caller returns not-delivered.
pub(crate) fn is_owned_foreground(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
) -> bool {
    #[cfg(all(test, target_os = "windows"))]
    if never_foreground::is_active() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        is_foreground_window(handle) && evidence.owns_handle_now().unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (handle, evidence);
        false
    }
}

#[cfg(target_os = "windows")]
fn restore_if_iconic(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
) -> Result<(), AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SW_RESTORE, ShowWindowAsync};
    unsafe {
        if IsIconic(handle) == 0 {
            return Ok(());
        }
        if !owned_for_write(evidence)? {
            return Err(recycled_before_foreground());
        }
        if ShowWindowAsync(handle, SW_RESTORE) == 0 {
            return Err(before_activation(hresult::win32_last_error(
                "ShowWindowAsync failed while restoring target",
            )));
        }
        #[cfg(test)]
        restore_probe::record();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn restore_if_iconic(
    _handle: super::window_enum::WindowHandle,
    _evidence: &WindowIdentityEvidence<'_>,
) -> Result<(), AdapterError> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn bring_to_foreground(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
) -> Result<(), AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SW_SHOW, SetForegroundWindow, ShowWindowAsync,
    };

    unsafe {
        if !owned_for_write(evidence)? {
            return Err(recycled_before_foreground());
        }
        if IsWindowVisible(handle) == 0 {
            if ShowWindowAsync(handle, SW_SHOW) == 0 {
                return Err(before_activation(hresult::win32_last_error(
                    "ShowWindowAsync failed while showing target",
                )));
            }
        }
        if !owned_for_write(evidence)? {
            return Err(recycled_before_foreground());
        }
        let _ = SetForegroundWindow(handle);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn bring_to_foreground(
    _handle: super::window_enum::WindowHandle,
    _evidence: &WindowIdentityEvidence<'_>,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("focus_window"))
}

fn owned_for_write(evidence: &WindowIdentityEvidence<'_>) -> Result<bool, AdapterError> {
    #[cfg(all(test, target_os = "windows"))]
    if force_unowned_from_attempt::blocks(attempt_probe::current()) {
        return Ok(false);
    }
    evidence.owns_handle_now()
}

/// The handle's owner changed between selection and the foreground write; the
/// write is refused so a recycled HWND never foregrounds a foreign window.
///
/// What this cannot promise, stated so it is a known limit rather than a
/// missed case: Win32 offers no atomic "act on this window only while that
/// process still owns it", so an ownership read and the native call it guards
/// are always two instructions. A recycle landing between them mutates the
/// replacement window, and nothing can undo that. Three things bound it: the
/// read sits immediately before each write, the only unconditional write left
/// is the foreground call itself (the visibility write is skipped when the
/// window is already visible, which it is on every path that reaches here),
/// and success is ownership-qualified — so the outcome of losing the race is
/// a foreign window raised once and an honest not-delivered refusal, never
/// input delivered to it. Closing it entirely needs a kernel primitive that
/// does not exist.
fn recycled_before_foreground() -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        "Target window handle changed ownership before foreground delivery",
    )
    .with_details(serde_json::json!({ "physical_delivery_started": false }))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(all(test, target_os = "windows"))]
#[path = "window_activate_hooks.rs"]
mod hooks;

#[cfg(all(test, target_os = "windows"))]
use hooks::{
    attempt_probe, force_strictly_higher, force_unowned_from_attempt, never_foreground,
    restore_probe,
};

#[cfg(test)]
#[path = "window_activate_policy_tests.rs"]
mod policy_tests;

#[cfg(test)]
#[path = "window_activate_tests.rs"]
mod tests;
