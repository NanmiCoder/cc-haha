use crate::{
    AppError, ErrorCode, ProcessIdentity, WindowInfo,
    adapter::{PlatformAdapter, WindowFilter},
};
use serde_json::json;

pub(crate) fn find_window_for_process(
    process: ProcessIdentity,
    adapter: &dyn PlatformAdapter,
    deadline: crate::Deadline,
) -> Result<WindowInfo, AppError> {
    let filter = WindowFilter {
        focused_only: false,
        app: None,
    };
    let same_pid: Vec<_> = adapter
        .list_windows(&filter, deadline)?
        .into_iter()
        .filter(|window| window.pid == process.pid)
        .collect();
    let incomplete_count = same_pid
        .iter()
        .filter(|window| window.process_instance.as_deref().is_none_or(str::is_empty))
        .count();
    if incomplete_count > 0 {
        return Err(crate::AdapterError::new(
            ErrorCode::ActionNotSupported,
            "Window inventory has incomplete process identity",
        )
        .with_details(json!({
            "candidate_count": same_pid.len(),
            "incomplete_identity_count": incomplete_count,
        }))
        .into());
    }
    let candidates: Vec<_> = same_pid
        .into_iter()
        .filter(|window| window.process_instance.as_deref() == Some(process.instance.as_str()))
        .collect();
    select_window(
        candidates,
        crate::AdapterError::new(
            ErrorCode::WindowNotFound,
            "No window found for the selected process instance",
        ),
        "Multiple windows matched the selected process instance",
    )
}

/// A menu bar, menu, or alert belongs to the application, not to one of its
/// windows, so several open windows are not an ambiguity for those surfaces —
/// any window of the app names the same process. Prefers a focused or visible
/// window so the caller still gets the most relevant identity.
pub(crate) fn select_surface_owner(
    candidates: Vec<WindowInfo>,
    empty_error: crate::AdapterError,
) -> Result<WindowInfo, AppError> {
    if candidates.is_empty() {
        return Err(empty_error.unsent().into());
    }
    let best = candidates
        .iter()
        .position(|window| window.state.is_focused)
        .or_else(|| {
            candidates
                .iter()
                .position(|window| window.state.visible == Some(true))
        })
        .unwrap_or(0);
    let mut candidates = candidates;
    Ok(candidates.swap_remove(best))
}

/// Orders an app's windows the way a surface owner is chosen: focused first,
/// then visible, then the rest, each group in the order the platform listed.
pub(crate) fn surface_owner_order(mut candidates: Vec<WindowInfo>) -> Vec<WindowInfo> {
    candidates.sort_by_key(|window| (!window.state.is_focused, window.state.visible != Some(true)));
    candidates
}

pub(crate) fn select_window(
    mut candidates: Vec<WindowInfo>,
    empty_error: crate::AdapterError,
    ambiguous_message: &str,
) -> Result<WindowInfo, AppError> {
    if candidates.is_empty() {
        return Err(empty_error.unsent().into());
    }
    if candidates.len() == 1 {
        return Ok(candidates.swap_remove(0));
    }
    if candidates
        .iter()
        .any(|window| window.state.visible == Some(true))
    {
        candidates.retain(|window| window.state.visible == Some(true));
        if candidates.len() == 1 {
            return Ok(candidates.swap_remove(0));
        }
    }
    let focused = candidates
        .iter()
        .position(|window| window.state.is_focused)
        .filter(|first| {
            !candidates[*first + 1..]
                .iter()
                .any(|window| window.state.is_focused)
        });
    if let Some(index) = focused {
        return Ok(candidates.swap_remove(index));
    }
    if candidates.iter().any(|window| window.state.accessible) {
        candidates.retain(|window| window.state.accessible);
        if candidates.len() == 1 {
            return Ok(candidates.swap_remove(0));
        }
    }
    let summaries = candidates
        .iter()
        .take(10)
        .map(|window| {
            json!({
                "id": window.id,
                "title": window.title,
                "is_focused": window.state.is_focused,
                "visible": window.state.visible,
            })
        })
        .collect::<Vec<_>>();
    Err(crate::AdapterError::ambiguous_target(ambiguous_message)
        .with_suggestion("Run 'list-windows' and retry with --window-id <id>.")
        .with_details(json!({
            "candidate_count": candidates.len(),
            "candidate_summaries_truncated": candidates.len() > summaries.len(),
            "candidates": summaries,
        }))
        .into())
}

#[cfg(test)]
#[path = "window_lookup_tests.rs"]
mod tests;
