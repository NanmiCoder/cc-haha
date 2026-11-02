use agent_desktop_core::{AdapterError, AppInfo, AppPresentation, Deadline, ProcessId};

use super::process_identity;
use super::window::window_enum::{EnumeratedWindow, enumerate_top_level};
use super::window::window_ops::passes_filter;

const PROTECTED_PROCESSES: &[&str] = &[
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "smss.exe",
    "lsaiso.exe",
    "dwm.exe",
    "explorer.exe",
];

/// Exact case-insensitive `.exe` image-name match against the session- and
/// shell-critical set. Near-misses (`iexplore.exe`, `explorer++.exe`, a name
/// merely containing `lsass`) are deliberately not protected.
pub(crate) fn is_protected_process(identifier: &str) -> bool {
    let image = identifier.rsplit(['\\', '/']).next().unwrap_or(identifier);
    PROTECTED_PROCESSES
        .iter()
        .any(|protected| image.eq_ignore_ascii_case(protected))
}

/// A process snapshot row: the image name and the identity token for one pid.
///
/// `list_apps` joins the window inventory's owning processes with this
/// snapshot so the two inventories corroborate each other on
/// `process_instance` (mirroring
/// `crates/macos/src/system/app/app_inventory.rs:133-146` where two sources must
/// agree or the inventory fails).
#[derive(Debug, Clone)]
pub(crate) struct ProcessRow {
    pub(crate) pid: ProcessId,
    pub(crate) name: String,
}

/// `CreateToolhelp32Snapshot` reports failure as `INVALID_HANDLE_VALUE`
/// (`-1`), never as a null handle, so an `is_null` guard can never fire and
/// a failed call would read as an empty enumeration rather than an error.
/// Snapshots every running process's image name from the ToolHelp table.
#[cfg(target_os = "windows")]
pub(crate) fn process_snapshot() -> Result<Vec<ProcessRow>, AdapterError> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(AdapterError::internal(
            "CreateToolhelp32Snapshot failed to enumerate processes",
        ));
    }
    let mut rows = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        rows.push(ProcessRow {
            pid: ProcessId::from(entry.th32ProcessID),
            name: process_identity::wide_buffer_to_string(&entry.szExeFile),
        });
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(snapshot);
    }
    Ok(rows)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_snapshot() -> Result<Vec<ProcessRow>, AdapterError> {
    Ok(Vec::new())
}

/// The owning processes of the agent-facing window set - the "apps with a
/// window" population `list_apps` reports.
///
/// Checks `deadline` between windows, matching `process_state.rs:140-153`:
/// the enumeration itself is cheap, but the budget still bounds however long
/// the whole walk is allowed to take before the app assembly loop starts its
/// own per-window process-handle work.
#[cfg(target_os = "windows")]
fn owning_processes(deadline: Deadline) -> Result<Vec<EnumeratedWindow>, AdapterError> {
    #[cfg(test)]
    enumeration_calls::record();

    let mut owners = Vec::new();
    let failure = std::cell::RefCell::new(None);
    let mut seen = 0usize;
    enumerate_top_level(|window| {
        if seen > 0 {
            if let Err(error) = deadline.ensure_remaining() {
                *failure.borrow_mut() = Some(error);
                return false;
            }
        }
        seen += 1;
        if passes_filter(&window) {
            owners.push(window);
        }
        true
    })?;
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    Ok(owners)
}

#[cfg(not(target_os = "windows"))]
fn owning_processes(_deadline: Deadline) -> Result<Vec<EnumeratedWindow>, AdapterError> {
    Ok(Vec::new())
}

/// The live `list_apps` inventory.
///
/// Every listed app owns at least one agent-facing window (the A16-1 filter)
/// and corroborates its identity against the process snapshot: a pid present
/// in the window inventory but absent from the process snapshot fails the
/// inventory rather than emitting a half-identified app. The process
/// generation the inventory captured is re-read at assembly time and compared,
/// so a mid-listing generation change also fails the inventory. `bundle_id`
/// has no Windows analogue and is recorded, not faked.
///
/// Every listed app is `foreground`: the filter keeps only visible, uncloaked,
/// non-tool top-level windows, which is the set the taskbar shows.
///
/// Bounds every native call under `deadline`, refusing before any
/// enumeration when the budget is already spent and checking it again
/// between the per-window process-handle reads the assembly loop performs.
pub(crate) fn list_apps_live(deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
    deadline.ensure_remaining()?;
    let owners = owning_processes(deadline)?;
    let snapshot = process_snapshot()?;
    let snapshot_by_pid: std::collections::HashMap<u32, &ProcessRow> = snapshot
        .iter()
        .map(|row| (u32::from(row.pid), row))
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for (index, window) in owners.into_iter().enumerate() {
        if index > 0 {
            deadline.ensure_remaining()?;
        }
        let Some((pid, token)) = process_token_of(window.handle) else {
            continue;
        };
        if !seen.insert(pid) {
            continue;
        }
        let Some(row) = snapshot_by_pid.get(&u32::from(pid)) else {
            return Err(AdapterError::internal(
                "a window-owning process is absent from the process snapshot",
            ));
        };
        if let Some(window_token) = token.as_deref() {
            let fresh = process_identity::token_for_pid(pid).ok().flatten();
            if fresh.as_deref() != Some(window_token) {
                return Err(AdapterError::internal(
                    "window and process identities disagree for an app",
                ));
            }
        }
        apps.push(AppInfo {
            name: row.name.clone(),
            pid,
            bundle_id: None,
            process_instance: token,
            presentation: Some(AppPresentation::Foreground),
        });
    }
    apps.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(apps)
}

/// The owner pid + token for a window, reusing the identity path.
fn process_token_of(
    handle: super::window::window_enum::WindowHandle,
) -> Option<(ProcessId, Option<String>)> {
    #[cfg(target_os = "windows")]
    {
        let pid = super::window::window_identity::live_window_owner(handle)?;
        let token = process_identity::token_for_pid(pid).ok().flatten();
        Some((pid, token))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        None
    }
}

#[cfg(test)]
pub(super) mod enumeration_calls {
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn record() {
        crate::system::fixture::call_counter::record(&COUNT);
    }

    pub(super) fn take() -> usize {
        crate::system::fixture::call_counter::take(&COUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_already_expired_deadline_returns_timeout_without_enumerating() {
        enumeration_calls::take();
        let expired = Deadline::after(0).expect("a zero-timeout deadline is constructible");

        let error = list_apps_live(expired).expect_err("an expired deadline must refuse listing");

        assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
        assert_eq!(
            enumeration_calls::take(),
            0,
            "an already-expired deadline must perform no native enumeration"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn process_snapshot_lists_the_current_process() {
        let rows = process_snapshot().expect("the snapshot enumerates");

        assert!(
            rows.iter()
                .any(|row| row.pid == ProcessId::from(std::process::id())),
            "the current process must be in its own snapshot"
        );
        assert!(
            rows.iter()
                .find(|row| row.pid == ProcessId::from(std::process::id()))
                .is_some_and(|row| !row.name.is_empty()),
            "the current process has a non-empty image name"
        );
    }

    #[test]
    fn protected_list_members_match_exactly_case_insensitively() {
        for name in PROTECTED_PROCESSES {
            assert!(is_protected_process(name), "{name} must be protected");
            assert!(
                is_protected_process(&name.to_ascii_uppercase()),
                "{name} must match case-insensitively"
            );
        }
        assert!(is_protected_process("explorer.exe"));
        assert!(is_protected_process(r"C:\Windows\explorer.exe"));
    }

    #[test]
    fn near_miss_image_names_are_not_protected() {
        assert!(!is_protected_process("iexplore.exe"));
        assert!(!is_protected_process("explorer++.exe"));
        assert!(!is_protected_process("notepad.exe"));
        assert!(!is_protected_process("my-lsass-helper.exe"));
        assert!(!is_protected_process("lsass"));
        assert!(!is_protected_process("lsass.exe.bak"));
    }

    /// A listed app owns a taskbar window, so it is reported as a registered
    /// foreground app; an omitted presentation reads as a helper process and
    /// made `launch --cdp` miss the running instance it must refuse.
    #[cfg(target_os = "windows")]
    #[test]
    fn a_listed_window_owning_app_is_foreground() {
        crate::tree::fixture::bootstrap();
        let fixture = crate::tree::fixture::HostedFixture::spawn().expect("fixture");
        let pid = agent_desktop_core::ProcessId::new(fixture.process_id());
        let apps = list_apps_live(Deadline::standard().expect("deadline")).expect("inventory");
        let listed = apps
            .iter()
            .find(|app| app.pid == pid)
            .expect("the fixture's window makes it a listed app");
        assert_eq!(listed.presentation, Some(AppPresentation::Foreground));
    }
}
