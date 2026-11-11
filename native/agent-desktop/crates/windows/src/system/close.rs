use agent_desktop_core::{
    AdapterError, AppInfo, Deadline, DeliverySemantics, ErrorCode, ProcessId,
};
use std::time::Duration;

use super::app_ops::is_protected_process;
#[cfg(target_os = "windows")]
use super::close_dispatch::CloseDispatch;
use super::close_outcome::CloseOutcome;
use super::process_identity;
#[cfg(target_os = "windows")]
use super::runtime::hresult::{adapter_error_from_win32, win32_last_error};

const EXIT_POLL: Duration = Duration::from_millis(25);

pub(crate) fn close_app_impl(
    app: &AppInfo,
    force: bool,
    deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    ensure_not_protected(&app.name)?;
    if let Some(bundle_id) = &app.bundle_id {
        ensure_not_protected(bundle_id)?;
    }
    let instance = app.process_instance.as_deref().ok_or_else(|| {
        before_termination(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Exact close requires a process instance token",
        ))
    })?;
    close_verified(app, instance, force, deadline)
}

#[cfg(target_os = "windows")]
fn close_verified(
    app: &AppInfo,
    instance: &str,
    force: bool,
    deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    deadline.ensure_remaining().map_err(before_termination)?;
    if process_observed_gone(app.pid, instance).map_err(before_termination)? {
        return Ok(CloseOutcome::AlreadyGone);
    }
    let dispatch = if force {
        force_terminate(app.pid, instance, deadline)?
    } else {
        graceful_close(app.pid, instance, deadline)?
    };
    if dispatch == CloseDispatch::AlreadyGone {
        return Ok(CloseOutcome::AlreadyGone);
    }
    wait_for_exit(&app.name, app.pid, instance, force, deadline)?;
    Ok(CloseOutcome::Exited)
}

#[cfg(not(target_os = "windows"))]
fn close_verified(
    _app: &AppInfo,
    _instance: &str,
    _force: bool,
    _deadline: Deadline,
) -> Result<CloseOutcome, AdapterError> {
    Err(AdapterError::not_supported("close_app"))
}

fn ensure_not_protected(id: &str) -> Result<(), AdapterError> {
    if is_protected_process(id) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("'{id}' is a protected system process and cannot be closed"),
        )
        .with_suggestion(
            "Target a regular application; session-critical processes are never closed.",
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn graceful_close(
    pid: ProcessId,
    instance: &str,
    deadline: Deadline,
) -> Result<CloseDispatch, AdapterError> {
    deadline.ensure_remaining().map_err(before_termination)?;
    let windows = top_level_windows_for_pid(pid).map_err(before_termination)?;
    if windows.is_empty() {
        return windowless_graceful_fallback(pid, instance, deadline);
    }
    let delivered = broadcast_close(&windows, deadline, |hwnd| {
        post_wm_close_if_still_owned(hwnd, pid, instance)
    })?;
    if delivered {
        Ok(CloseDispatch::Sent)
    } else {
        windowless_graceful_fallback(pid, instance, deadline)
    }
}

/// Posts the close request to every owned window, reporting whether any of
/// them actually received it.
///
/// A multi-window app only closes when the request reaches the window that
/// owns its shutdown, so one window's refusal must not cancel delivery to its
/// siblings - and a window destroyed between enumeration and post is the
/// expected shape once an app starts tearing itself down in response to an
/// earlier post in this very loop. The fan-out therefore keeps going and only
/// surfaces a failure when **no** window accepted the request and at least
/// one post actually failed; when at least one post succeeded,
/// `wait_for_exit`'s independent process-gone re-read is the source of truth,
/// not the count of successful posts. That is also why a deadline that
/// expires mid-fan-out stops the loop instead of failing it: a request
/// already posted may already be closing the app, so reporting `not_delivered`
/// there would tell the caller a retry is free when it is not.
///
/// Ownership can also change mid-loop without any post failing, when every
/// window this pid owned at enumeration time has since been reassigned or
/// torn down; that posts nothing and fails nothing, so it is reported as
/// `Ok(false)` rather than folded into an unconditional success. The caller
/// must then apply the same liveness check it uses for a process that had no
/// windows at all, rather than assume the OS accepted a request that was
/// never sent.
fn broadcast_close(
    windows: &[isize],
    deadline: Deadline,
    mut post: impl FnMut(isize) -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    let mut delivered = false;
    let mut first_failure = None;
    for hwnd in windows {
        if deadline.ensure_remaining().is_err() {
            if delivered {
                break;
            }
            return Err(before_termination(deadline.timeout_error()));
        }
        match post(*hwnd) {
            Ok(true) => delivered = true,
            Ok(false) => {}
            Err(error) => {
                if first_failure.is_none() {
                    first_failure = Some(error);
                }
            }
        }
    }
    match first_failure {
        Some(error) if !delivered => Err(before_termination(error)),
        _ => Ok(delivered),
    }
}

/// The honest verdict when no close request could be delivered.
///
/// Reached two ways: the process owned no top-level window at enumeration
/// time, and every window it did own was skipped because ownership changed
/// before the post. Both mean the same thing to a caller - nothing was sent -
/// so both get the same answer, and a process that has since exited is still
/// the benign success it would have been anyway.
#[cfg(target_os = "windows")]
fn windowless_graceful_fallback(
    pid: ProcessId,
    instance: &str,
    deadline: Deadline,
) -> Result<CloseDispatch, AdapterError> {
    deadline.ensure_remaining().map_err(before_termination)?;
    if process_observed_gone(pid, instance).map_err(before_termination)? {
        return Ok(CloseDispatch::AlreadyGone);
    }
    Err(AdapterError::new(
        ErrorCode::ActionFailed,
        format!("No window owned by process {pid} could receive WM_CLOSE"),
    )
    .with_details(serde_json::json!({ "pid": u32::from(pid) }))
    .with_suggestion(format!(
        "Retry with --force to terminate pid {pid} without WM_CLOSE"
    ))
    .with_disposition(DeliverySemantics::not_delivered()))
}

#[cfg(target_os = "windows")]
fn force_terminate(
    pid: ProcessId,
    instance: &str,
    deadline: Deadline,
) -> Result<CloseDispatch, AdapterError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess,
    };

    deadline.ensure_remaining().map_err(before_termination)?;
    if process_observed_gone(pid, instance).map_err(before_termination)? {
        return Ok(CloseDispatch::AlreadyGone);
    }
    let access = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    if handle.is_null() {
        if process_observed_gone(pid, instance).map_err(before_termination)? {
            return Ok(CloseDispatch::AlreadyGone);
        }
        return Err(before_termination(win32_last_error(
            "OpenProcess failed before TerminateProcess",
        )));
    }
    let token_matches = handle_matches_instance(handle, pid, instance).map_err(|error| {
        unsafe { CloseHandle(handle) };
        before_termination(error)
    })?;
    if !token_matches {
        unsafe { CloseHandle(handle) };
        return Ok(CloseDispatch::AlreadyGone);
    }
    let ok = unsafe { TerminateProcess(handle, 1) };
    let error = if ok == 0 {
        Some(unsafe { windows_sys::Win32::Foundation::GetLastError() })
    } else {
        None
    };
    unsafe { CloseHandle(handle) };
    if let Some(code) = error {
        if process_observed_gone(pid, instance).map_err(before_termination)? {
            return Ok(CloseDispatch::AlreadyGone);
        }
        return Err(before_termination(adapter_error_from_win32(
            code,
            "TerminateProcess failed",
        )));
    }
    Ok(CloseDispatch::Sent)
}

#[cfg(target_os = "windows")]
fn wait_for_exit(
    id: &str,
    pid: ProcessId,
    instance: &str,
    force: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    loop {
        if process_observed_gone(pid, instance).map_err(after_termination)? {
            return Ok(());
        }
        if deadline.is_expired() {
            return Err(deadline
                .timeout_error()
                .with_details(serde_json::json!({
                    "app": id,
                    "pid": u32::from(pid),
                    "force": force,
                }))
                .with_disposition(DeliverySemantics::delivered_unverified()));
        }
        deadline.ensure_remaining().map_err(after_termination)?;
        let pause = deadline
            .remaining_slice(EXIT_POLL)
            .map_err(after_termination)?;
        std::thread::sleep(pause.min(EXIT_POLL));
    }
}

/// Wait-gated exit observation (A21-3): a signaled handle whose exit code
/// reads, or a creation-time token that no longer matches a live pid.
///
/// The wait decides, never the code. A process may legitimately exit with
/// `259`, which is the same value `GetExitCodeProcess` reports for a live
/// process, so vetoing on that value would leave a cleanly exited process
/// looking alive for as long as any handle keeps it from being reaped - which
/// the caller's own child handle routinely does. `process_state` gates the
/// same way for the same reason.
#[cfg(target_os = "windows")]
fn process_observed_gone(pid: ProcessId, instance: &str) -> Result<bool, AdapterError> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        WaitForSingleObject,
    };

    if !process_identity::matches_instance(pid, instance)? {
        return Ok(true);
    }
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    if handle.is_null() {
        return Ok(!process_identity::matches_instance(pid, instance)?);
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    let mut code: u32 = 0;
    let read_ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    if wait == WAIT_OBJECT_0 && read_ok != 0 {
        return Ok(true);
    }
    Ok(!process_identity::matches_instance(pid, instance)?)
}

#[cfg(target_os = "windows")]
fn top_level_windows_for_pid(pid: ProcessId) -> Result<Vec<isize>, AdapterError> {
    let mut handles = Vec::new();
    super::window::window_enum::enumerate_top_level(|window| {
        if super::window::window_identity::live_window_owner(window.handle) == Some(pid) {
            handles.push(window.handle as isize);
        }
        true
    })?;
    Ok(handles)
}

#[cfg(target_os = "windows")]
/// Posts `WM_CLOSE` to one window, reporting whether the request was actually
/// delivered so the fan-out can tell a deliberate skip from a send.
fn post_wm_close_if_still_owned(
    hwnd: isize,
    pid: ProcessId,
    instance: &str,
) -> Result<bool, AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};

    let hwnd = hwnd as super::window::window_enum::WindowHandle;
    if super::window::window_identity::live_window_owner(hwnd) != Some(pid) {
        return Ok(false);
    }
    if !process_identity::matches_instance(pid, instance)? {
        return Ok(false);
    }
    let posted = unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
    if posted == 0 {
        return Err(win32_last_error("PostMessageW(WM_CLOSE) failed"));
    }
    Ok(true)
}

/// Verifies the open process handle's creation times still match `instance`
/// before a terminate write, so a recycled pid cannot be killed.
#[cfg(target_os = "windows")]
fn handle_matches_instance(
    handle: windows_sys::Win32::Foundation::HANDLE,
    _pid: ProcessId,
    instance: &str,
) -> Result<bool, AdapterError> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let mut created = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let read_ok =
        unsafe { GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) };
    if read_ok == 0 {
        return Ok(false);
    }
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    if ticks == 0 {
        return Ok(false);
    }
    const TICKS_PER_SECOND: u64 = 10_000_000;
    let from_handle = format!(
        "windows-proc-v1:{}:{}",
        ticks / TICKS_PER_SECOND,
        ticks % TICKS_PER_SECOND
    );
    Ok(from_handle == instance)
}

fn before_termination(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn after_termination(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(test)]
#[path = "close_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "close_fanout_tests.rs"]
mod fanout_tests;
