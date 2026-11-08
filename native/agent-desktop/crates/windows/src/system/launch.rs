use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessId, RendererKind, WindowFilter,
    WindowInfo, system::launch_options::LaunchOptions, system::launch_result::LaunchResult,
};
#[cfg(test)]
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

#[cfg(test)]
use self::launch_attach::matching_processes;
use self::launch_attach::prepare;
use super::app_ops::ProcessRow;
use super::launch_path::{
    child_environment_block, image_file_name, launch_identifier, validate_launch_options,
};
use super::process_identity;
#[cfg(target_os = "windows")]
use super::runtime::hresult::win32_last_error;
use super::window::window_ops::list_windows_live;

pub(crate) fn launch_app_impl(
    id: &str,
    options: &LaunchOptions,
    parent_deadline: Deadline,
) -> Result<LaunchResult, AdapterError> {
    let id = &launch_identifier(id).map_err(before_launch)?;
    validate_launch_options(options).map_err(before_launch)?;
    let deadline = if options.timeout_ms == 0 {
        parent_deadline
    } else {
        parent_deadline.capped(Duration::from_millis(options.timeout_ms))
    };
    deadline.ensure_remaining().map_err(before_launch)?;
    let (executable, attached) = prepare(id, options, deadline).map_err(before_launch)?;
    if let Some(attached) = attached {
        return Ok(attached);
    }
    let (pid, token) = create_process(&executable, options, deadline)?;
    let window = observe_window(pid, &token, options, deadline)?;
    Ok(launch_result(id, pid, token, window))
}

/// The window a launch actually caused, or `None`. A process that presents no
/// window is a fact the caller reads from `LaunchResult.window`, not a failure:
/// a background or windowless process is a legitimate launch outcome, and
/// erroring on it made every such launch spend its whole timeout first.
fn observe_window(
    pid: ProcessId,
    process_instance: &str,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let mut poll_interval = Duration::from_millis(50);
    loop {
        if let Some(window) = observe_window_once(pid, process_instance, deadline)? {
            return Ok(Some(window));
        }
        if !should_poll_after_first_observation(options.timeout_ms)
            || deadline.remaining().is_zero()
        {
            return Ok(None);
        }
        let remaining = deadline.remaining();
        std::thread::sleep(poll_interval.min(remaining));
        poll_interval = (poll_interval * 3 / 2).min(Duration::from_millis(250));
    }
}

fn launch_result(
    id: &str,
    pid: ProcessId,
    process_instance: String,
    window: Option<WindowInfo>,
) -> LaunchResult {
    let renderer = window.as_ref().and_then(detect_renderer_from_window);
    LaunchResult {
        app: window
            .as_ref()
            .map(|window| window.app.clone())
            .unwrap_or_else(|| image_file_name(id).to_string()),
        pid,
        process_instance: Some(process_instance),
        window,
        cdp: None,
        renderer,
        suggestion: None,
    }
}

#[cfg(target_os = "windows")]
fn detect_renderer_from_window(window: &WindowInfo) -> Option<RendererKind> {
    const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_1";
    let handle = super::window::window_ops::parse_handle(&window.id);
    if handle.is_null() {
        return None;
    }
    super::window::window_ops::window_class_name(handle)
        .filter(|class| class == CHROMIUM_WINDOW_CLASS)
        .map(|_| RendererKind::Chromium)
}

#[cfg(not(target_os = "windows"))]
fn detect_renderer_from_window(_window: &WindowInfo) -> Option<RendererKind> {
    None
}

/// One window observation, tolerant of the inventory's mid-walk identity race.
///
/// `list_windows_live` now absorbs that race itself (the shared listing-retry
/// budget every caller on this path shares), retrying internally before ever
/// returning `WINDOW_NOT_FOUND` — so this function no longer re-reads the
/// inventory itself. A launch is exactly the moment that race is most
/// reachable, since a process was just created or terminated, but a race that
/// still survives the shared budget, and a budget that runs out entirely
/// (`TIMEOUT`), both say the desktop could not be read coherently in time —
/// not that this launch failed — so both are reported as no window observed.
/// Every other failure still propagates: a target whose process instance
/// changed underneath the launch is a real answer, not a race.
fn observe_window_once(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    match exact_window(pid, process_instance, deadline) {
        Ok(window) => Ok(window),
        Err(error) if is_unobservable_within_budget(&error) => Ok(None),
        Err(error) => Err(after_launch(error)),
    }
}

fn is_unobservable_within_budget(error: &AdapterError) -> bool {
    matches!(error.code, ErrorCode::WindowNotFound | ErrorCode::Timeout)
}

fn exact_window(
    pid: ProcessId,
    process_instance: &str,
    deadline: Deadline,
) -> Result<Option<WindowInfo>, AdapterError> {
    let windows = list_windows_live(
        &WindowFilter {
            focused_only: false,
            app: None,
        },
        deadline,
    )?;
    let Some(window) = windows.into_iter().find(|window| window.pid == pid) else {
        return Ok(None);
    };
    if window.process_instance.as_deref() != Some(process_instance) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Application process instance changed while waiting for its window",
        )
        .with_details(serde_json::json!({ "pid": pid, "complete": false })));
    }
    Ok(Some(window))
}

/// Refuses a relative working directory before it reaches `CreateProcessW`.
///
/// The child's current directory sits early in the default DLL search order,
/// so it picks which copy of a dependency loads; a relative path resolves
/// against whatever directory this process happens to hold, not the caller's.
#[cfg(target_os = "windows")]
fn absolute_cwd(cwd: &Path) -> Result<&Path, AdapterError> {
    if cwd.is_absolute() {
        return Ok(cwd);
    }
    Err(before_launch(AdapterError::new(
        ErrorCode::InvalidArgs,
        "The launch working directory must be an absolute path",
    )))
}

#[cfg(target_os = "windows")]
fn create_process(
    executable: &Path,
    options: &LaunchOptions,
    deadline: Deadline,
) -> Result<(ProcessId, String), AdapterError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CREATE_UNICODE_ENVIRONMENT, CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW,
    };

    deadline.ensure_remaining().map_err(before_launch)?;
    let app_wide = to_wide(executable).map_err(before_launch)?;
    let command_line = command_line_for(executable, &options.args).map_err(before_launch)?;
    let mut command_wide = to_wide_str(&command_line).map_err(before_launch)?;
    let cwd_wide = match &options.cwd {
        Some(cwd) => Some(to_wide(absolute_cwd(cwd)?).map_err(before_launch)?),
        None => None,
    };
    let env_block = child_environment_block(
        &options.env,
        crate::system::interaction_lease::INTERACTION_LEASE_HANDLE_ENV,
    )
    .map_err(before_launch)?;
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut information = PROCESS_INFORMATION::default();
    let flags = if env_block.is_some() {
        CREATE_UNICODE_ENVIRONMENT
    } else {
        0
    };
    let env_ptr = env_block
        .as_ref()
        .map(|block| block.as_ptr().cast())
        .unwrap_or(std::ptr::null());
    let cwd_ptr = cwd_wide
        .as_ref()
        .map(|wide| wide.as_ptr())
        .unwrap_or(std::ptr::null());
    deadline.ensure_remaining().map_err(before_launch)?;
    let ok = unsafe {
        CreateProcessW(
            app_wide.as_ptr(),
            command_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            env_ptr,
            cwd_ptr,
            &startup,
            &mut information,
        )
    };
    if ok == 0 {
        return Err(before_launch(win32_last_error(
            "CreateProcessW failed to start the application",
        )));
    }
    let pid = ProcessId::from(information.dwProcessId);
    unsafe {
        CloseHandle(information.hThread);
        CloseHandle(information.hProcess);
    }
    let token = process_identity::token_for_pid(pid)
        .map_err(after_launch)?
        .ok_or_else(|| {
            after_launch(
                AdapterError::new(
                    ErrorCode::AppUnresponsive,
                    "Created process has no exact process instance token",
                )
                .with_details(serde_json::json!({ "pid": pid, "complete": false })),
            )
        })?;
    Ok((pid, token))
}

#[cfg(not(target_os = "windows"))]
fn create_process(
    _executable: &Path,
    _options: &LaunchOptions,
    _deadline: Deadline,
) -> Result<(ProcessId, String), AdapterError> {
    Err(AdapterError::not_supported("launch_app"))
}

fn command_line_for(executable: &Path, args: &[String]) -> Result<String, AdapterError> {
    let mut line = quote_arg(&executable.to_string_lossy());
    for arg in args {
        line.push(' ');
        line.push_str(&quote_arg(arg));
    }
    Ok(line)
}

/// Encodes one argument for the command line the child parses back apart.
///
/// The trailing backslash run is the case that silently corrupts: backslashes
/// are literal except immediately before a quote, so a value ending in one
/// would escape the closing quote this appends, leaving the quoted region open
/// and swallowing every later argument into it. That run is therefore doubled.
/// An embedded quote stays doubled rather than backslash-escaped: that is a
/// valid encoding for the consecutive-quote rule and the form `cmd` accepts,
/// which backslash-escaping is not.
fn quote_arg(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    for ch in value.chars() {
        if ch == '"' {
            out.push('"');
        }
        out.push(ch);
    }
    let trailing = value.len() - value.trim_end_matches('\\').len();
    for _ in 0..trailing {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Pass-through kept here, under this module's own name, purely so this
/// module's own tests (`launch_tests.rs`) can call it unqualified through
/// their `use super::*;`; the merge itself lives in `launch_path` beside
/// every other input-shape rule a launch enforces, and `create_process`
/// reaches it through `child_environment_block` rather than this name. Only
/// that test caller remains, so this exists for `#[cfg(test)]` builds alone.
#[cfg(test)]
fn environment_block(overrides: &BTreeMap<String, String>) -> Result<Vec<u16>, AdapterError> {
    super::launch_path::environment_block(overrides)
}

#[cfg(target_os = "windows")]
fn to_wide(path: &Path) -> Result<Vec<u16>, AdapterError> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch path contains an interior NUL",
        ));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(target_os = "windows")]
fn to_wide_str(value: &str) -> Result<Vec<u16>, AdapterError> {
    if value.contains('\0') {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Launch command line contains an interior NUL",
        ));
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    Ok(wide)
}

fn already_running_error(pid: ProcessId, matches: &[ProcessRow]) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, "Application is already running")
        .with_details(serde_json::json!({
            "pid": pid,
            "candidate_pids": matches.iter().map(|row| row.pid).collect::<Vec<_>>(),
        }))
        .with_suggestion("Omit --no-attach to attach to the running instance, or close it first.")
}

fn ambiguous_apps(matches: &[ProcessRow]) -> AdapterError {
    AdapterError::ambiguous_process_target(
        "More than one application instance matches the launch target",
        &matches.iter().map(|row| row.pid).collect::<Vec<_>>(),
    )
}

fn before_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn after_launch(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

fn should_poll_after_first_observation(timeout_ms: u64) -> bool {
    timeout_ms > 0
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "launch_lease_isolation_tests.rs"]
mod launch_lease_isolation_tests;

#[path = "launch_attach.rs"]
pub(crate) mod launch_attach;
