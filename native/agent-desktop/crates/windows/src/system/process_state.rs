#[cfg(target_os = "windows")]
use super::runtime::hresult::win32_last_error;
use agent_desktop_core::{
    AdapterError, Deadline, ProcessIdentity, system::process_state::ProcessState,
};

/// Result of one hang-probe pass over a process's top-level windows.
///
/// Decoupled from Win32 so the two-signal threshold (one transient hung
/// pass must not classify `Unresponsive`; two consecutive must) is
/// unit-testable without a live hung window (A21-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HangProbeResult {
    Responsive,
    Hung,
}

const CRASH_NIBBLE_MASK: u32 = 0xF000_0000;
const CRASH_NIBBLE_VALUE: u32 = 0xC000_0000;
const MAX_PROBED_WINDOWS: usize = 16;
const PER_PROBE_BUDGET_FRACTION: u64 = 8;
const PER_PROBE_CAP_MS: u64 = 500;

/// Pure hang classification for a process already known to be alive.
///
/// Kept free of platform APIs so the retry threshold is unit-testable on
/// every host, matching the macOS `classify` shape.
pub(crate) fn classify_hang(
    mut probe: impl FnMut() -> Result<HangProbeResult, AdapterError>,
) -> Result<ProcessState, AdapterError> {
    Ok(match probe()? {
        HangProbeResult::Responsive => ProcessState::Running,
        HangProbeResult::Hung => match probe()? {
            HangProbeResult::Responsive => ProcessState::Running,
            HangProbeResult::Hung => ProcessState::Unresponsive,
        },
    })
}

/// Maps a wait-confirmed exit code onto `Exited` / `Crashed` (A21-3).
///
/// `Crashed` when the high nibble is `0xC` (NTSTATUS unhandled-exception
/// shape); otherwise `Exited`. The wait gate, not this helper, decides
/// whether the process is gone - a live process whose code reads as
/// `STILL_ACTIVE` (`259`) must never reach here.
pub(crate) fn state_from_exit_code(code: u32) -> ProcessState {
    if (code & CRASH_NIBBLE_MASK) == CRASH_NIBBLE_VALUE {
        ProcessState::Crashed {
            signal_or_code: code as i32,
        }
    } else {
        ProcessState::Exited {
            code: Some(code as i32),
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn process_state_impl(
    process: ProcessIdentity,
    deadline: Deadline,
) -> Result<ProcessState, AdapterError> {
    deadline.ensure_remaining()?;
    if !super::process_identity::matches_instance(process.pid, &process.instance)? {
        return Ok(ProcessState::Exited { code: None });
    }
    let handle = match open_process_for_state(process.pid) {
        Ok(handle) => handle,
        Err(error) => {
            if !super::process_identity::matches_instance(process.pid, &process.instance)? {
                return Ok(ProcessState::Exited { code: None });
            }
            return Err(error);
        }
    };
    let state = classify_opened(handle, process.pid, deadline);
    close_handle(handle);
    let state = state?;
    if super::process_identity::matches_instance(process.pid, &process.instance)? {
        Ok(state)
    } else {
        Ok(ProcessState::Exited { code: None })
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_state_impl(
    _process: ProcessIdentity,
    _deadline: Deadline,
) -> Result<ProcessState, AdapterError> {
    Err(AdapterError::not_supported("process_state"))
}

/// `WaitForSingleObject` on a process handle settles into exactly one of
/// three outcomes, and only one of them means the process is alive:
/// `WAIT_OBJECT_0` (the handle is signaled - the process has exited, so its
/// exit code can be read and classified), `WAIT_TIMEOUT` (the handle is
/// still unsignaled - the process is genuinely running, so classification
/// proceeds to the window-hang probe), or `WAIT_FAILED` (the wait itself
/// could not judge liveness at all, most often because the handle was
/// opened without `SYNCHRONIZE` rights, e.g. across an integrity boundary).
/// A failed wait is not a timeout wearing a different name: folding it into
/// the `WAIT_TIMEOUT` path would report a process this call cannot see as
/// confidently alive, so it surfaces as the classified Win32 error instead
/// of an invented state.
#[cfg(target_os = "windows")]
fn classify_opened(
    handle: windows_sys::Win32::Foundation::HANDLE,
    pid: agent_desktop_core::ProcessId,
    deadline: Deadline,
) -> Result<ProcessState, AdapterError> {
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};

    deadline.ensure_remaining()?;
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    if wait == WAIT_OBJECT_0 {
        let mut code: u32 = 0;
        if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
            return Err(win32_last_error(
                "GetExitCodeProcess failed after the process handle signaled",
            ));
        }
        return Ok(state_from_exit_code(code));
    }
    if wait != WAIT_TIMEOUT {
        return Err(win32_last_error(
            "WaitForSingleObject failed and could not judge process liveness",
        ));
    }
    let windows = top_level_windows_for(pid)?;
    if windows.is_empty() {
        return Ok(ProcessState::Running);
    }
    classify_hang(|| {
        deadline.ensure_remaining()?;
        probe_windows_once(&windows, deadline)
    })
}

#[cfg(target_os = "windows")]
fn probe_windows_once(
    windows: &[isize],
    deadline: Deadline,
) -> Result<HangProbeResult, AdapterError> {
    for (index, hwnd) in windows.iter().copied().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        if window_is_hung(hwnd, deadline) {
            return Ok(HangProbeResult::Hung);
        }
    }
    Ok(HangProbeResult::Responsive)
}

#[cfg(target_os = "windows")]
fn window_is_hung(hwnd: isize, deadline: Deadline) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsHungAppWindow;

    if unsafe { IsHungAppWindow(hwnd as *mut core::ffi::c_void) } == 0 {
        return false;
    }
    let probe_ms = probe_timeout_ms(deadline);
    !crate::tree::automation::window_is_pumping(hwnd, probe_ms)
}

fn probe_timeout_ms(deadline: Deadline) -> u64 {
    deadline
        .remaining_ms()
        .saturating_div(PER_PROBE_BUDGET_FRACTION)
        .clamp(1, PER_PROBE_CAP_MS)
}

#[cfg(target_os = "windows")]
fn top_level_windows_for(pid: agent_desktop_core::ProcessId) -> Result<Vec<isize>, AdapterError> {
    let mut handles = Vec::new();
    super::window::window_enum::enumerate_top_level(|window| {
        if handles.len() >= MAX_PROBED_WINDOWS {
            return false;
        }
        if super::window::window_identity::live_window_owner(window.handle) == Some(pid) {
            handles.push(window.handle as isize);
        }
        true
    })?;
    Ok(handles)
}

#[cfg(target_os = "windows")]
fn open_process_for_state(
    pid: agent_desktop_core::ProcessId,
) -> Result<windows_sys::Win32::Foundation::HANDLE, AdapterError> {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let handle = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    if handle.is_null() {
        return Err(win32_last_error(
            "OpenProcess failed for process_state liveness check",
        ));
    }
    Ok(handle)
}

#[cfg(target_os = "windows")]
fn close_handle(handle: windows_sys::Win32::Foundation::HANDLE) {
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(handle);
    }
}

#[cfg(test)]
#[path = "process_state_tests.rs"]
mod tests;
