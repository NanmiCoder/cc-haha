use agent_desktop_core::{AdapterError, ProcessId};

/// The process-generation token: a creation-time-derived identity that
/// survives HWND recycling, mirroring macOS's
/// `"macos-proc-v1:{start_seconds}:{start_microseconds}"` shape.
///
/// Windows FILETIME is 100-nanosecond ticks since 1601; the token keeps the
/// integer second and the sub-second tick so two processes started in the same
/// second stay distinct, the same way the macOS token's microsecond field
/// does. A token is read from the process handle the identity check already
/// needs, so the identity never costs a separate enumeration.
const TOKEN_PREFIX: &str = "windows-proc-v1";
const TICKS_PER_SECOND: u64 = 10_000_000;

/// A fixed-width, nul-padded wide buffer - `PROCESSENTRY32W::szExeFile`,
/// `WIN32_FIND_DATAW::cFileName` and their kin - cut at its first nul and
/// decoded. The tail after the terminator is whatever a previous, longer
/// value left there, so reading the whole array would append those
/// leftovers to a shorter name.
pub(crate) fn wide_buffer_to_string(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pid: ProcessId,
    creation_seconds: u64,
    creation_subtick: u64,
}

impl ProcessIdentity {
    /// Captures the process-generation identity for `pid`.
    ///
    /// `None` is the honest answer for a process whose token cannot be read
    /// (an elevated-process handle the caller cannot open, per the split-
    /// integrity measurement A16-12): the window still lists, with
    /// `process_instance: None`, and fails closed on resolution.
    #[cfg(target_os = "windows")]
    pub(crate) fn capture(pid: ProcessId) -> Result<Option<Self>, AdapterError> {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let raw_pid = u32::from(pid);
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, raw_pid) };
        if process.is_null() {
            return Ok(None);
        }
        let mut created = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let read_ok =
            unsafe { GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) };
        unsafe { CloseHandle(process) };
        if read_ok == 0 {
            return Ok(None);
        }
        let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        if ticks == 0 {
            return Ok(None);
        }
        Ok(Some(Self {
            pid,
            creation_seconds: ticks / TICKS_PER_SECOND,
            creation_subtick: ticks % TICKS_PER_SECOND,
        }))
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn capture(_pid: ProcessId) -> Result<Option<Self>, AdapterError> {
        Ok(None)
    }

    pub(crate) fn token(self) -> String {
        format!(
            "{TOKEN_PREFIX}:{}:{}",
            self.creation_seconds, self.creation_subtick
        )
    }

    /// Whether this identity still matches the process at `pid` right now.
    pub(crate) fn still_matches(self) -> Result<bool, AdapterError> {
        Ok(Self::capture(self.pid)?.is_some_and(|current| current == self))
    }
}

pub(crate) fn token_for_pid(pid: ProcessId) -> Result<Option<String>, AdapterError> {
    Ok(ProcessIdentity::capture(pid)?.map(ProcessIdentity::token))
}

#[cfg(target_os = "windows")]
pub(crate) fn process_is_running(pid: ProcessId) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let process = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    if process.is_null() {
        return true;
    }
    let wait = unsafe { WaitForSingleObject(process, 0) };
    unsafe { CloseHandle(process) };
    wait != WAIT_OBJECT_0
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_is_running(_pid: ProcessId) -> bool {
    true
}

/// Blocks on the process object itself for at most `window` and reports
/// whether the process exited inside it.
///
/// `process_is_running` is a zero-timeout poll, so a process that is tearing
/// down but not yet signaled reads as running. This waits on the handle, an
/// event rather than a sleep, so the exit is observed the instant it happens.
/// A pid that no longer names a process (`ERROR_INVALID_PARAMETER`) has
/// exited; any other failure to open the handle cannot confirm an exit and
/// reports `false` without waiting.
#[cfg(target_os = "windows")]
pub(crate) fn wait_for_exit(pid: ProcessId, window: std::time::Duration) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE;
    let process = unsafe { OpenProcess(access, 0, u32::from(pid)) };
    if process.is_null() {
        return unsafe { GetLastError() } == ERROR_INVALID_PARAMETER;
    }
    let millis = u32::try_from(window.as_millis()).unwrap_or(u32::MAX);
    let wait = unsafe { WaitForSingleObject(process, millis) };
    unsafe { CloseHandle(process) };
    wait == WAIT_OBJECT_0
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn wait_for_exit(_pid: ProcessId, _window: std::time::Duration) -> bool {
    false
}

/// The image name (executable filename) of the process at `pid`, read from
/// the ToolHelp process table.
///
/// `CreateToolhelp32Snapshot` reports failure as `INVALID_HANDLE_VALUE`
/// (`-1`), never as a null handle, so an `is_null` guard can never fire and
/// a failed call would read as an empty enumeration rather than an error.
///
/// The single walk both window identity checks corroborate `app` against:
/// `window_ops.rs` and `window_identity.rs` each carried their own verbatim
/// copy of this loop before it was pulled out from underneath them.
#[cfg(target_os = "windows")]
pub(crate) fn process_image_name(pid: ProcessId) -> Option<String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut found = None;
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == u32::from(pid) {
            found = Some(wide_buffer_to_string(&entry.szExeFile));
            break;
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
    }
    found
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_image_name(_pid: ProcessId) -> Option<String> {
    None
}

/// Verifies a stored token against the process's current generation.
///
/// A recycled PID whose process is a different generation fails closed; a PID
/// whose process is gone altogether reads `None` and also fails. This is the
/// check a recycled HWND on a different process generation trips.
pub(crate) fn matches_instance(pid: ProcessId, token: &str) -> Result<bool, AdapterError> {
    let expected = match parse_token(pid, token)? {
        Some(identity) => identity,
        None => return Ok(false),
    };
    expected.still_matches()
}

/// Parses a token back into a comparable identity, or `None` for an
/// unrecognised shape - which must not match anything.
fn parse_token(pid: ProcessId, token: &str) -> Result<Option<ProcessIdentity>, AdapterError> {
    let mut parts = token.split(':');
    if parts.next() != Some(TOKEN_PREFIX) {
        return Ok(None);
    }
    let (seconds, subtick) = match (parts.next(), parts.next()) {
        (Some(seconds), Some(subtick)) => match (seconds.parse::<u64>(), subtick.parse::<u64>()) {
            (Ok(seconds), Ok(subtick)) => (seconds, subtick),
            _ => return Ok(None),
        },
        _ => return Ok(None),
    };
    Ok(Some(ProcessIdentity {
        pid,
        creation_seconds: seconds,
        creation_subtick: subtick,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn process_image_name_finds_the_current_process() {
        let name = process_image_name(ProcessId::from(std::process::id()));

        assert!(
            name.is_some_and(|name| !name.is_empty()),
            "the current process must find its own image name in the process table"
        );
    }

    #[test]
    fn token_shape_mirrors_macos_is_two_component_creation_time() {
        let identity = ProcessIdentity {
            pid: ProcessId::new(1),
            creation_seconds: 1_700_000_000,
            creation_subtick: 123_456,
        };

        assert_eq!(identity.token(), "windows-proc-v1:1700000000:123456");
    }

    #[test]
    fn two_processes_started_in_the_same_second_stay_distinct() {
        let first = ProcessIdentity {
            pid: ProcessId::new(1),
            creation_seconds: 1_700_000_000,
            creation_subtick: 100,
        };
        let second = ProcessIdentity {
            pid: ProcessId::new(1),
            creation_seconds: 1_700_000_000,
            creation_subtick: 200,
        };

        assert_ne!(first, second);
        assert_ne!(first.token(), second.token());
    }

    #[test]
    fn a_different_generation_is_a_different_identity() {
        let before = ProcessIdentity {
            pid: ProcessId::new(1),
            creation_seconds: 1_700_000_000,
            creation_subtick: 100,
        };
        let after = ProcessIdentity {
            pid: ProcessId::new(1),
            creation_seconds: 1_700_000_100,
            creation_subtick: 100,
        };

        assert_ne!(before, after);
        assert_eq!(before.pid, after.pid);
        assert_ne!(before.token(), after.token());
    }

    #[test]
    fn a_shape_mismatch_matches_nothing() {
        let pid = ProcessId::new(1);

        assert!(!matches_instance(pid, "macos-proc-v1:1:2").unwrap());
        assert!(!matches_instance(pid, "windows-proc-v2:1:2").unwrap());
        assert!(!matches_instance(pid, "windows-proc-v1:nope:2").unwrap());
        assert!(!matches_instance(pid, "").unwrap());
    }

    #[test]
    fn a_fresh_token_matches_its_own_process() {
        let pid = ProcessId::from(std::process::id());
        let Some(token) = token_for_pid(pid).unwrap() else {
            return;
        };

        assert!(
            matches_instance(pid, &token).unwrap(),
            "a freshly captured token must match the same process"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn an_exited_process_with_its_child_handle_held_is_not_running() {
        for exit_code in [0, 259] {
            let mut child = std::process::Command::new("cmd")
                .args(["/c", "exit", &exit_code.to_string()])
                .spawn()
                .expect("spawn child");
            let pid = ProcessId::from(child.id());
            assert_eq!(
                child.wait().expect("wait for child exit").code(),
                Some(exit_code)
            );

            assert!(!process_is_running(pid), "child exited with {exit_code}");
        }
        assert!(process_is_running(ProcessId::from(std::process::id())));
    }

    /// The recycled-pid case: a well-formed token whose generation does not
    /// match the live process at that pid - the shape a new process reusing
    /// an old HWND's pid trips - must fail closed on both entry points.
    #[test]
    fn a_generation_mismatched_token_fails_closed() {
        let pid = ProcessId::from(std::process::id());
        let Some(current) = ProcessIdentity::capture(pid).unwrap() else {
            return;
        };
        let corrupted = ProcessIdentity {
            creation_seconds: current.creation_seconds.wrapping_add(1),
            ..current
        };

        assert!(
            !corrupted.still_matches().unwrap(),
            "a different generation of the same pid must not still-match"
        );
        assert!(
            !matches_instance(pid, &corrupted.token()).unwrap(),
            "a generation-mismatched token must not match the live process"
        );
    }
}
