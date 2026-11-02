use agent_desktop_core::{
    AdapterError, Deadline, InteractionPolicy, NotificationFilter, NotificationInfo,
};

use super::nc_session::{NcSession, close_session};

pub fn list_notifications(
    filter: &NotificationFilter,
    policy: InteractionPolicy,
    deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    let session = NcSession::open(policy, deadline)?;
    let result = list_from_nc(filter, session.pid(), deadline);
    close_session(session, result)
}

#[cfg(target_os = "macos")]
fn list_from_nc(
    filter: &NotificationFilter,
    pid: i32,
    deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    let entries = list_entries(filter, pid, deadline)?;
    Ok(entries.into_iter().map(|e| e.info).collect())
}

#[cfg(target_os = "macos")]
pub(super) struct NotificationEntry {
    pub info: NotificationInfo,
    pub element: crate::tree::AXElement,
}

#[cfg(target_os = "macos")]
pub(super) fn list_entries(
    filter: &NotificationFilter,
    pid: i32,
    deadline: Deadline,
) -> Result<Vec<NotificationEntry>, AdapterError> {
    use crate::tree::element_for_pid;

    let app = element_for_pid(pid);
    let windows = crate::notifications::read::children_for_attribute(&app, "AXWindows", deadline)?;
    if windows.is_empty() {
        return Ok(vec![]);
    }

    let mut scan = super::scan::NotificationScan::new(filter, deadline);
    for window in &windows {
        let top_children = crate::notifications::read::children(window, deadline)?;
        scan.collect(&top_children, 0)?;
        if scan.is_full() {
            break;
        }
    }
    Ok(scan.finish())
}

pub(super) fn matches_filters(
    info: &NotificationInfo,
    app_filter: &Option<String>,
    text_filter: &Option<String>,
) -> bool {
    if let Some(app) = app_filter {
        if !info.app_name.to_lowercase().contains(app) {
            return false;
        }
    }
    if let Some(text) = text_filter {
        let haystack = format!(
            "{} {} {}",
            info.title,
            info.body.as_deref().unwrap_or(""),
            info.app_name
        )
        .to_lowercase();
        if !haystack.contains(text) {
            return false;
        }
    }
    true
}

#[cfg(not(target_os = "macos"))]
fn list_from_nc(
    _filter: &NotificationFilter,
    _pid: i32,
    _deadline: Deadline,
) -> Result<Vec<NotificationInfo>, AdapterError> {
    Err(AdapterError::not_supported("list_notifications"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_info(app: &str, title: &str, body: Option<&str>) -> NotificationInfo {
        NotificationInfo {
            index: 1,
            app_name: app.into(),
            title: title.into(),
            body: body.map(String::from),
            actions: vec![],
        }
    }

    #[test]
    fn matches_filters_no_filter() {
        let info = make_info("Slack", "Hello", None);
        assert!(matches_filters(&info, &None, &None));
    }

    #[test]
    fn matches_filters_app_match() {
        let info = make_info("Slack", "Hello", None);
        assert!(matches_filters(&info, &Some("slack".into()), &None));
        assert!(!matches_filters(&info, &Some("teams".into()), &None));
    }

    #[test]
    fn matches_filters_text_match() {
        let info = make_info("Slack", "Hello world", Some("body text"));
        assert!(matches_filters(&info, &None, &Some("hello".into())));
        assert!(matches_filters(&info, &None, &Some("body".into())));
        assert!(!matches_filters(&info, &None, &Some("missing".into())));
    }

    #[test]
    fn matches_filters_combined() {
        let info = make_info("Slack", "Hello", None);
        assert!(matches_filters(
            &info,
            &Some("slack".into()),
            &Some("hello".into())
        ));
        assert!(!matches_filters(
            &info,
            &Some("teams".into()),
            &Some("hello".into())
        ));
    }
}
