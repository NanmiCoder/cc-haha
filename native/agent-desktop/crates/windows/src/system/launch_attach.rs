use std::path::{Path, PathBuf};

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, ProcessId, system::launch_options::LaunchOptions,
    system::launch_result::LaunchResult,
};

use super::super::app_ops::{ProcessRow, process_snapshot};
use super::super::launch_path::{image_file_name, resolve_executable};
use super::super::process_identity;

pub(super) fn prepare(
    id: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<(PathBuf, Option<LaunchResult>), AdapterError> {
    let matches = matching_processes(image_file_name(id))?;
    if !options.attach_if_running {
        if let Some(row) = matches.first() {
            return Err(super::already_running_error(row.pid, &matches));
        }
        return Ok((resolve_executable(id)?, None));
    }

    let executable = resolve_executable(id)?;
    let mut exact_matches = Vec::new();
    for row in matches {
        let Some(process) = ProcessPin::open(row.pid) else {
            continue;
        };
        let Some(image_path) = process.image_path() else {
            continue;
        };
        if same_executable_path(&executable, &image_path) {
            let token = process_identity::token_for_pid(row.pid)?.ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "Running process has no exact process instance token",
                )
            })?;
            exact_matches.push((row, token, process));
        }
    }
    if exact_matches.len() > 1 {
        let rows = exact_matches
            .iter()
            .map(|(row, _, _)| row.clone())
            .collect::<Vec<_>>();
        return Err(super::ambiguous_apps(&rows));
    }
    if let Some((row, token, _process)) = exact_matches.pop() {
        let window = super::observe_window(row.pid, &token, options, deadline)?;
        return Ok((
            executable,
            Some(super::launch_result(id, row.pid, token, window)),
        ));
    }
    Ok((executable, None))
}

pub(super) fn matching_processes(image: &str) -> Result<Vec<ProcessRow>, AdapterError> {
    Ok(process_snapshot()?
        .into_iter()
        .filter(|row| row.name.eq_ignore_ascii_case(image))
        .collect())
}

fn same_executable_path(expected: &Path, actual: &Path) -> bool {
    std::fs::canonicalize(expected)
        .ok()
        .zip(std::fs::canonicalize(actual).ok())
        .is_some_and(|(expected, actual)| expected == actual)
}

#[cfg(target_os = "windows")]
struct ProcessPin(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl ProcessPin {
    fn open(pid: ProcessId) -> Option<Self> {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, u32::from(pid)) };
        (!handle.is_null()).then_some(Self(handle))
    }

    fn image_path(&self) -> Option<PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;

        let mut buffer = vec![0_u16; 32_768];
        let mut size = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(self.0, 0, buffer.as_mut_ptr(), &mut size) };
        if ok == 0 || size == 0 {
            return None;
        }
        Some(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..size as usize],
        )))
    }
}

#[cfg(target_os = "windows")]
impl Drop for ProcessPin {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(target_os = "windows"))]
struct ProcessPin;

#[cfg(not(target_os = "windows"))]
impl ProcessPin {
    fn open(_pid: ProcessId) -> Option<Self> {
        None
    }

    fn image_path(&self) -> Option<PathBuf> {
        None
    }
}
