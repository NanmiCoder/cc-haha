use agent_desktop_core::{AdapterError, ErrorCode, WindowInfo};

use crate::system::window::cg_window::WindowRecord;
use crate::tree::{AXElement, element_for_pid, properties::attributes::set_messaging_timeout};

pub(crate) struct WindowIdentityEvidence<'a> {
    pub pid: i32,
    pub app: Option<&'a str>,
    pub process_instance: Option<&'a str>,
    pub title: Option<&'a str>,
    pub bounds_hash: Option<u64>,
}

pub(crate) fn window_element_for_info(
    win: &WindowInfo,
    deadline: agent_desktop_core::Deadline,
) -> Result<AXElement, AdapterError> {
    window_element_for_info_with_deadline(
        win,
        std::time::Instant::now()
            .checked_add(deadline.remaining())
            .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "deadline is out of range"))?,
    )
}

pub(crate) fn window_element_for_info_with_deadline(
    win: &WindowInfo,
    deadline: std::time::Instant,
) -> Result<AXElement, AdapterError> {
    if win.id.is_empty() {
        let pid = crate::system::process::process_identity::to_pid_t(win.pid)?;
        return window_element_by_title(pid, &win.title, deadline);
    }
    resolve_window_element_strict(win, deadline)
}

pub(crate) fn resolve_capture_window(
    win: &WindowInfo,
    deadline: std::time::Instant,
) -> Result<WindowInfo, AdapterError> {
    let (_, record) = locate_verified_record_until(win, deadline)?;
    window_info_from_record(win, &record)
}

pub(crate) fn resolve_window_strict(
    win: &WindowInfo,
    deadline: std::time::Instant,
) -> Result<WindowInfo, AdapterError> {
    let (window_number, record) = locate_verified_record_until(win, deadline)?;
    let ax_state = crate::system::window::window_ax_state::read_until(record.pid, deadline)?;
    verify_window_record(win, &record)?;
    let mut resolved = window_info_from_record(win, &record)?;
    resolved.state.minimized = ax_state.minimized_by_id.get(&window_number).copied();
    if let Some((_, Some(focused_number))) = ax_state.focused {
        resolved.state.is_focused = focused_number == window_number;
    }
    Ok(resolved)
}

fn locate_verified_record_until(
    win: &WindowInfo,
    deadline: std::time::Instant,
) -> Result<(i64, WindowRecord), AdapterError> {
    let window_number = parse_window_number(&win.id).ok_or_else(|| invalid_window_id(&win.id))?;
    let record =
        crate::system::window::cg_window_exact::exact_window_record_until(window_number, deadline)?
            .ok_or_else(|| window_not_found(&win.id))?;
    verify_window_record(win, &record)?;
    Ok((window_number, record))
}

pub(crate) fn verify_window_identity_until(
    id: &str,
    evidence: WindowIdentityEvidence<'_>,
    deadline: std::time::Instant,
) -> Result<(), AdapterError> {
    let window_number = parse_window_number(id).ok_or_else(|| invalid_window_id(id))?;
    let record =
        crate::system::window::cg_window_exact::exact_window_record_until(window_number, deadline)?
            .ok_or_else(|| window_not_found(id))?;
    if !window_record_matches_source(&record, &evidence) {
        return Err(window_identity_mismatch(id));
    }
    let Some(process_instance) = evidence.process_instance else {
        return Err(window_identity_mismatch(id));
    };
    if !crate::system::process::process_identity::matches_instance(evidence.pid, process_instance)?
    {
        return Err(window_identity_mismatch(id));
    }
    Ok(())
}

fn window_record_matches_source(
    record: &WindowRecord,
    evidence: &WindowIdentityEvidence<'_>,
) -> bool {
    if record.pid != evidence.pid
        || evidence
            .app
            .is_some_and(|app| !app.is_empty() && record.app_name != app)
        || evidence.process_instance.is_none()
        || record.process_instance.as_deref() != evidence.process_instance
    {
        return false;
    }
    let bounds_changed = evidence.bounds_hash.is_some_and(|expected| {
        record
            .bounds
            .bounds_hash()
            .is_none_or(|actual| actual != expected)
    });
    if bounds_changed {
        tracing::debug!(
            expected_bounds_hash = ?evidence.bounds_hash,
            actual_bounds_hash = ?record.bounds.bounds_hash(),
            "window moved or resized while immutable source identity remained valid"
        );
    }
    let title_changed = evidence.title.is_some_and(|title| {
        !title.is_empty() && record.title.as_deref().unwrap_or(record.app_name.as_str()) != title
    });
    if title_changed {
        tracing::debug!("window title changed while immutable source identity remained valid");
    }
    true
}

fn resolve_window_element_strict(
    win: &WindowInfo,
    deadline: std::time::Instant,
) -> Result<AXElement, AdapterError> {
    crate::tree::locator_deadline::remaining(deadline)?;
    let (window_number, record) = locate_verified_record_until(win, deadline)?;
    crate::tree::locator_deadline::remaining(deadline)?;
    let pid = crate::system::process::process_identity::to_pid_t(win.pid)?;
    ax_window_element_for_number(pid, window_number, record.title.as_deref(), deadline)?
        .ok_or_else(|| window_not_accessible(&win.id))
}

pub(crate) fn parse_window_number(id: &str) -> Option<i64> {
    id.strip_prefix('w')?
        .strip_prefix('-')?
        .parse()
        .ok()
        .filter(|number| *number > 0)
}

fn verify_window_record(win: &WindowInfo, record: &WindowRecord) -> Result<(), AdapterError> {
    let pid = crate::system::process::process_identity::to_pid_t(win.pid)?;
    if record.pid != pid {
        return Err(window_identity_mismatch(&win.id));
    }
    let Some(instance) = win.process_instance.as_deref() else {
        return Err(window_identity_mismatch(&win.id));
    };
    if record.process_instance.as_deref() != Some(instance)
        || !crate::system::process::process_identity::matches_instance(pid, instance)?
    {
        return Err(window_identity_mismatch(&win.id));
    }
    if !win.app.is_empty() && record.app_name != win.app {
        return Err(window_identity_mismatch(&win.id));
    }
    if !win.title.is_empty() {
        let record_title = record.title.as_deref().unwrap_or(record.app_name.as_str());
        if record_title != win.title {
            return Err(window_identity_mismatch(&win.id));
        }
    }
    Ok(())
}

fn window_info_from_record(
    win: &WindowInfo,
    record: &WindowRecord,
) -> Result<WindowInfo, AdapterError> {
    Ok(WindowInfo {
        id: win.id.clone(),
        title: record
            .title
            .clone()
            .unwrap_or_else(|| record.app_name.clone()),
        app: record.app_name.clone(),
        pid: crate::system::process::process_identity::from_pid_t(record.pid)?,
        process_instance: record.process_instance.clone(),
        bounds: Some(record.bounds),
        state: agent_desktop_core::WindowState {
            is_focused: win.state.is_focused,
            accessible: win.state.accessible,
            minimized: win.state.minimized,
            visible: Some(record.visible),
        },
    })
}

fn ax_window_element_for_number(
    pid: i32,
    window_number: i64,
    fallback_title: Option<&str>,
    deadline: std::time::Instant,
) -> Result<Option<AXElement>, AdapterError> {
    let windows = windows_for_pid(pid, deadline)?;
    let mut unavailable_bridge = None;
    for window in &windows {
        prepare_for_read(window, deadline)?;
        if crate::tree::resolve::resolve_ax_read::read_string(window, "AXRole", deadline)?
            .as_deref()
            != Some("AXWindow")
        {
            continue;
        }
        match ax_window_id_with_deadline(window, deadline) {
            Ok(Some(actual)) if actual == window_number => return Ok(Some(window.clone())),
            Ok(_) => {}
            Err(error) if crate::system::window::window_bridge::is_unavailable(&error) => {
                unavailable_bridge = Some(error);
                break;
            }
            Err(error) => return Err(error),
        }
    }
    let Some(title) = fallback_title else {
        return match unavailable_bridge {
            Some(error) => Err(error),
            None => Ok(None),
        };
    };
    let mut single_match = None;
    for window in windows {
        prepare_for_read(&window, deadline)?;
        if crate::tree::resolve::resolve_ax_read::read_string(&window, "AXRole", deadline)?
            .as_deref()
            != Some("AXWindow")
        {
            continue;
        }
        if crate::tree::resolve::resolve_ax_read::read_string(&window, "AXTitle", deadline)?
            .as_deref()
            != Some(title)
        {
            continue;
        }
        if single_match.is_some() {
            return Err(AdapterError::ambiguous_target(format!(
                "Multiple AX windows matched the verified CoreGraphics title '{title}'"
            ))
            .with_details(serde_json::json!({
                "kind": "verified_window_title_ambiguous",
                "title": title,
            })));
        }
        single_match = Some(window);
    }
    match single_match {
        Some(window) => Ok(Some(window)),
        None => match unavailable_bridge {
            Some(error) => Err(error),
            None => Ok(None),
        },
    }
}

fn window_element_by_title(
    pid: i32,
    requested_title: &str,
    deadline: std::time::Instant,
) -> Result<AXElement, AdapterError> {
    let windows = windows_for_pid(pid, deadline)?;
    let mut exact = Vec::new();
    let mut window_count = 0_usize;
    let mut only_window = None;
    for window in windows {
        if crate::tree::resolve::resolve_ax_read::read_string(&window, "AXRole", deadline)?
            .as_deref()
            != Some("AXWindow")
        {
            continue;
        }
        window_count += 1;
        only_window = Some(window.clone());
        let title =
            crate::tree::resolve::resolve_ax_read::read_string(&window, "AXTitle", deadline)?;
        if title.as_deref() == Some(requested_title) && !requested_title.is_empty() {
            exact.push(window);
        }
    }
    if exact.len() == 1 {
        return Ok(exact.remove(0));
    }
    if exact.len() > 1 {
        return Err(AdapterError::ambiguous_target(format!(
            "Multiple windows have the exact title '{requested_title}'"
        ))
        .with_details(serde_json::json!({
            "kind": "window_title_ambiguous",
            "title": requested_title,
            "candidate_count": exact.len(),
        })));
    }
    if requested_title.is_empty() && window_count == 1 {
        return only_window.ok_or_else(|| window_not_found(requested_title));
    }
    Err(window_not_found(requested_title))
}

fn windows_for_pid(pid: i32, deadline: std::time::Instant) -> Result<Vec<AXElement>, AdapterError> {
    let app = element_for_pid(pid);
    #[cfg(target_os = "macos")]
    {
        Ok(
            crate::tree::resolve::resolve_ax_read::read_array(&app, "AXWindows", deadline)?
                .unwrap_or_default(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        prepare_for_read(&app, deadline)?;
        let windows = crate::tree::properties::attributes::copy_ax_array_result(&app, "AXWindows")
            .ok()
            .flatten()
            .unwrap_or_default();
        crate::tree::locator_deadline::remaining(deadline)?;
        Ok(windows)
    }
}

fn prepare_for_read(element: &AXElement, deadline: std::time::Instant) -> Result<(), AdapterError> {
    crate::tree::locator_deadline::remaining(deadline)?;
    set_messaging_timeout(element, deadline)?;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_window_id_with_deadline(
    window: &AXElement,
    deadline: std::time::Instant,
) -> Result<Option<i64>, AdapterError> {
    prepare_for_read(window, deadline)?;
    let window_id = crate::system::window::window_bridge::window_id(window, deadline)?;
    crate::tree::locator_deadline::remaining(deadline)?;
    Ok(window_id)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ax_window_id_with_deadline(
    _window: &AXElement,
    _deadline: std::time::Instant,
) -> Result<Option<i64>, AdapterError> {
    Ok(None)
}

fn invalid_window_id(id: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, format!("Invalid window id: '{id}'"))
        .with_suggestion("Window ids come from 'list-windows' (format w-<number>).")
}

/// The window exists in the CoreGraphics inventory but the owning application
/// does not publish it through accessibility. Reporting it as missing
/// contradicts `list-windows`, which correctly still lists it: screenshots and
/// coordinate input address CoreGraphics windows, only the semantic path needs
/// an accessibility element.
fn window_not_accessible(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        format!("Window '{id}' exists but is not exposed through accessibility"),
    )
    .with_details(serde_json::json!({
        "kind": "window_without_accessibility_element",
        "window_id": id,
    }))
    .with_suggestion(
        "This window supports screenshots and coordinate input only. Bring it on screen, \
         or target another window from 'list-windows'.",
    )
}

fn window_not_found(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        format!("Window '{id}' not found"),
    )
    .with_suggestion("Run 'list-windows' to see available windows and their IDs.")
}

fn window_identity_mismatch(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::WindowNotFound,
        format!("Window '{id}' identity mismatch"),
    )
    .with_suggestion("Run 'list-windows' to refresh window IDs, then retry.")
}

#[cfg(test)]
#[path = "window_resolve_tests.rs"]
mod tests;
