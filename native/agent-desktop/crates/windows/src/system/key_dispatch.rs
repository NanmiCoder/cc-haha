use std::time::{Duration, Instant};

use agent_desktop_core::{
    ActionResult, AdapterError, Deadline, DeliverySemantics, ErrorCode, InteractionPolicy,
    KeyCombo, ProcessId, ProcessIdentity,
};

use crate::input::elevation::ensure_target_integrity_allows_input;
use crate::input::keyboard::synthesize_key;
use crate::system::process_identity;

const KEYBOARD_FOCUS_WAIT: Duration = Duration::from_millis(500);
const KEYBOARD_FOCUS_POLL: Duration = Duration::from_millis(5);

/// Delivers a key combo to a named process by composing the keyboard primitive
/// under a verify-only focus gate. Core's headed path already activated before
/// this runs; this method never calls window activation.
pub(crate) fn press_for_app_impl(
    process: ProcessIdentity,
    combo: &KeyCombo,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<ActionResult, AdapterError> {
    tracing::debug!(
        pid = u32::from(process.pid),
        allow_focus_steal = policy.allow_focus_steal,
        "system: press key for app"
    );
    deadline.ensure_remaining()?;
    require_process(&process)?;
    ensure_injection_integrity(process.pid)?;
    ensure_foreground_for_delivery(&process, policy)?;
    require_process(&process)?;
    require_keyboard_focus(process.pid, &process.instance, deadline)?;
    require_process(&process)?;
    #[cfg(all(test, target_os = "windows"))]
    between_verify_and_inject::run();
    if !process_owns_foreground(process.pid, &process.instance)? {
        return Err(focus_lost_before_delivery(process.pid));
    }
    require_process(&process)?;
    run_synthesize(combo, deadline)?;
    post_delivery_process_result(&process)
}

fn ensure_injection_integrity(pid: ProcessId) -> Result<(), AdapterError> {
    #[cfg(all(test, target_os = "windows"))]
    if force_higher_integrity::is_active() {
        return crate::input::elevation::evaluate_integrity_gate(Some(0x2000), Some(0x3000))
            .map_err(as_predelivery_refusal);
    }
    ensure_target_integrity_allows_input(pid).map_err(as_predelivery_refusal)
}

/// Reframes the shared elevation gate's `raw_input_emitted` claim into this
/// file's own `physical_delivery_started` vocabulary.
///
/// `ensure_injection_integrity` runs at the top of `press_for_app_impl`,
/// before foreground verification or focus polling ever run, so the honest
/// claim at this call site is that the whole key-press delivery never
/// started - not narrowly that a raw injection call was skipped. The shared
/// gate's own wording stays correct for its other callers, which sit
/// immediately ahead of a raw injection call; leaving it unchanged here
/// would leave this file's own refusals describing the same fact two
/// different ways.
fn as_predelivery_refusal(mut error: AdapterError) -> AdapterError {
    let Some(object) = error
        .details
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    else {
        return error;
    };
    if let Some(value) = object.remove("raw_input_emitted") {
        object.insert("physical_delivery_started".to_string(), value);
    }
    error
}

fn ensure_foreground_for_delivery(
    process: &ProcessIdentity,
    policy: InteractionPolicy,
) -> Result<(), AdapterError> {
    if process_owns_foreground(process.pid, &process.instance)? {
        return Ok(());
    }
    Err(if policy.allow_focus_steal {
        focus_verify_failed(process.pid)
    } else {
        background_fail_closed(process.pid)
    })
}

fn require_process(process: &ProcessIdentity) -> Result<(), AdapterError> {
    if process_identity::matches_instance(process.pid, &process.instance)? {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Target process instance is no longer running",
        )
        .with_details(serde_json::json!({
            "pid": process.pid,
            "process_instance": process.instance,
            "complete": false,
            "physical_delivery_started": false,
        })))
    }
}

fn post_delivery_process_result(process: &ProcessIdentity) -> Result<ActionResult, AdapterError> {
    require_process(process)
        .map_err(|error| error.with_disposition(DeliverySemantics::delivered_unverified()))?;
    Ok(ActionResult::delivered_unverified("press_key"))
}

fn require_keyboard_focus(
    pid: ProcessId,
    instance: &str,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let local_deadline = bounded_instant(deadline, KEYBOARD_FOCUS_WAIT)?;
    loop {
        deadline.ensure_remaining()?;
        if process_holds_keyboard_focus(pid)? && process_identity::matches_instance(pid, instance)?
        {
            return Ok(());
        }
        if Instant::now() >= local_deadline {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "Application has no verified keyboard focus for key delivery",
            )
            .with_details(serde_json::json!({
                "pid": pid,
                "physical_delivery_started": false,
            }))
            .with_disposition(DeliverySemantics::not_delivered()));
        }
        let pause = deadline.remaining_slice(KEYBOARD_FOCUS_POLL)?;
        std::thread::sleep(pause.min(KEYBOARD_FOCUS_POLL));
    }
}

fn bounded_instant(deadline: Deadline, maximum: Duration) -> Result<Instant, AdapterError> {
    let remaining = deadline.remaining_slice(maximum)?;
    Instant::now()
        .checked_add(remaining)
        .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "Deadline is out of range"))
}

fn run_synthesize(combo: &KeyCombo, deadline: Deadline) -> Result<(), AdapterError> {
    #[cfg(all(test, target_os = "windows"))]
    synthesis_probe::note();
    synthesize_key(combo, deadline)
}

fn focus_verify_failed(pid: ProcessId) -> AdapterError {
    focus_lost_before_delivery(pid)
        .with_suggestion("Retry after ensuring the target application remains frontmost")
}

fn background_fail_closed(pid: ProcessId) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Target application is not foreground; Windows SendInput cannot deliver to a background process",
    )
    .with_details(serde_json::json!({
        "pid": pid,
        "physical_delivery_started": false,
    }))
    .with_suggestion(
        "Retry with --headed so the target can be activated first, or ensure the target is already foreground",
    )
    .with_disposition(DeliverySemantics::not_delivered())
}

fn focus_lost_before_delivery(pid: ProcessId) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "Target application lost focus before physical input delivery",
    )
    .with_details(serde_json::json!({
        "pid": pid,
        "physical_delivery_started": false,
    }))
    .with_disposition(DeliverySemantics::not_delivered())
}

#[cfg(target_os = "windows")]
fn process_owns_foreground(pid: ProcessId, instance: &str) -> Result<bool, AdapterError> {
    #[cfg(test)]
    if force_focus_lost::is_active() {
        return Ok(false);
    }
    let Some(foreground_pid) = foreground_process_id() else {
        return Ok(false);
    };
    if foreground_pid != pid {
        return Ok(false);
    }
    process_identity::matches_instance(pid, instance)
}

#[cfg(not(target_os = "windows"))]
fn process_owns_foreground(_pid: ProcessId, _instance: &str) -> Result<bool, AdapterError> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn process_holds_keyboard_focus(pid: ProcessId) -> Result<bool, AdapterError> {
    #[cfg(test)]
    if force_keyboard_focus_denied::is_active() {
        return Ok(false);
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{GUITHREADINFO, GetGUIThreadInfo};

    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let ok = unsafe { GetGUIThreadInfo(0, &mut info) };
    if ok == 0 {
        return Ok(false);
    }
    let focus = if !info.hwndFocus.is_null() {
        info.hwndFocus
    } else if !info.hwndActive.is_null() {
        info.hwndActive
    } else {
        return Ok(false);
    };
    Ok(super::window::window_identity::live_window_owner(focus) == Some(pid))
}

#[cfg(not(target_os = "windows"))]
fn process_holds_keyboard_focus(_pid: ProcessId) -> Result<bool, AdapterError> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn foreground_process_id() -> Option<ProcessId> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() {
        return None;
    }
    super::window::window_identity::live_window_owner(foreground)
}

#[cfg(all(test, target_os = "windows"))]
#[path = "key_dispatch_hooks.rs"]
mod hooks;

#[cfg(all(test, target_os = "windows"))]
use hooks::{
    between_verify_and_inject, force_focus_lost, force_higher_integrity,
    force_keyboard_focus_denied, synthesis_probe,
};

#[cfg(test)]
#[path = "key_dispatch_tests.rs"]
mod tests;

/// Split from `key_dispatch_tests.rs`, which sits at the per-file line cap:
/// this module owns the keyboard-focus verification timeout, a scenario
/// distinct from that file's foreground and integrity preflight gates.
#[cfg(test)]
#[path = "key_dispatch_focus_tests.rs"]
mod focus_tests;
