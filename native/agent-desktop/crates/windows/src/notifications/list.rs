use agent_desktop_core::{
    AdapterError, Deadline, InteractionPolicy, NotificationFilter, NotificationInfo,
};

use super::read::ListEntry;
use super::session::{ActionCenterSession, close_session};

#[cfg(test)]
#[path = "list_tests.rs"]
mod tests;

/// Lists the Action Center's notifications with the caller's filter applied.
///
/// Opening the list raises shell chrome, so the floor lives here rather than
/// in core: a strict-headless caller is refused when the center is closed and
/// would have to be raised, before anything moves on the desktop, while a
/// caller whose policy permits the foreground change - or whose center is
/// already presented - proceeds. The session is one call: the center is
/// restored to its entry state afterwards, on every path.
pub(crate) fn list_notifications(
    filter: &NotificationFilter,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    let session = ActionCenterSession::open(policy, deadline)?;
    let result = list_from_center(filter, session.hwnd(), deadline);
    close_session(session, result)
}

fn list_from_center(
    filter: &NotificationFilter,
    hwnd: isize,
    deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    Ok(list_entries(filter, hwnd, deadline)?
        .into_iter()
        .map(|entry| entry.info)
        .collect())
}

/// The mutation-side read: the same walk that produces the identities the
/// mutating paths verify against, keeping the live element beside every info
/// struct so an invoke lands on the entry that read produced.
pub(super) fn list_entries(
    filter: &NotificationFilter,
    hwnd: isize,
    deadline: Deadline,
) -> Result<Vec<ListEntry>, AdapterError> {
    let root = crate::tree::automation::root_from_hwnd(hwnd, deadline)?;
    let entries = super::read::read_entries(&root, deadline)?;
    Ok(finalize(entries, filter))
}

/// The infos-only read the verification paths re-read with.
pub(super) fn list_infos(
    filter: &NotificationFilter,
    hwnd: isize,
    deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    Ok(list_entries(filter, hwnd, deadline)?
        .into_iter()
        .map(|entry| entry.info)
        .collect())
}

/// Indices first, then predicates, then the limit - in that order.
///
/// An entry's index is its 1-based position among the recognized entries in
/// tree order, so it stays meaningful to the mutating commands no matter what
/// the filter kept. The app and text predicates run next, and the limit
/// truncates last: a limit applied before filtering would hand back fewer
/// entries than the caller asked to see whenever the filtered-out entries sit
/// early in the tree. The elements in the entries travel beside the infos the
/// pipeline kept, in the same order.
pub(super) fn finalize(entries: Vec<ListEntry>, filter: &NotificationFilter) -> Vec<ListEntry> {
    let survivors = order_and_filter(
        entries.iter().map(|entry| entry.info.clone()).collect(),
        filter,
    );
    let kept: Vec<usize> = survivors.iter().map(|info| info.index - 1).collect();
    let mut entries = entries;
    let mut surviving_entries = Vec::with_capacity(kept.len());
    for position in kept.into_iter().rev() {
        surviving_entries.push(entries.remove(position));
    }
    surviving_entries.reverse();
    for (entry, info) in surviving_entries.iter_mut().zip(survivors.iter()) {
        entry.info.index = info.index;
    }
    surviving_entries
}

fn order_and_filter(
    mut infos: Vec<NotificationInfo>,
    filter: &NotificationFilter,
) -> Vec<NotificationInfo> {
    for (position, info) in infos.iter_mut().enumerate() {
        info.index = position + 1;
    }
    let filtered: Vec<NotificationInfo> = infos
        .into_iter()
        .filter(|info| matches_filters(info, filter))
        .collect();
    match filter.limit {
        Some(limit) => filtered.into_iter().take(limit).collect(),
        None => filtered,
    }
}

fn matches_filters(info: &NotificationInfo, filter: &NotificationFilter) -> bool {
    if let Some(app) = filter.app.as_deref()
        && !info.app_name.to_lowercase().contains(&app.to_lowercase())
    {
        return false;
    }
    if let Some(text) = filter.text.as_deref() {
        let haystack = format!(
            "{} {} {}",
            info.title,
            info.body.as_deref().unwrap_or(""),
            info.app_name
        )
        .to_lowercase();
        if !haystack.contains(&text.to_lowercase()) {
            return false;
        }
    }
    true
}
