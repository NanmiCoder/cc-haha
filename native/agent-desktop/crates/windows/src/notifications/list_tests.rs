use agent_desktop_core::{NotificationFilter, NotificationInfo};

use super::order_and_filter;

fn info(app: &str, title: &str, body: Option<&str>) -> NotificationInfo {
    NotificationInfo {
        index: 0,
        app_name: app.into(),
        title: title.into(),
        body: body.map(String::from),
        actions: Vec::new(),
    }
}

fn filter(app: Option<&str>, text: Option<&str>, limit: Option<usize>) -> NotificationFilter {
    NotificationFilter {
        app: app.map(String::from),
        text: text.map(String::from),
        limit,
    }
}

#[test]
fn limit_truncates_after_filtering_not_before() {
    let ordered = order_and_filter(
        vec![
            info("App A", "kept", None),
            info("App B", "filtered out", None),
            info("App A", "also kept", None),
        ],
        &filter(Some("app a"), None, Some(2)),
    );

    let indices: Vec<usize> = ordered.iter().map(|entry| entry.index).collect();
    assert_eq!(
        indices,
        vec![1, 3],
        "a limit that ran before the app filter would hide the second match"
    );
}

#[test]
fn app_filter_keeps_only_matching_entries_and_keeps_their_tree_index() {
    let ordered = order_and_filter(
        vec![
            info("App A", "first", None),
            info("App B", "second", None),
            info("App A", "third", None),
        ],
        &filter(Some("app a"), None, None),
    );

    let indices: Vec<usize> = ordered.iter().map(|entry| entry.index).collect();
    assert_eq!(
        indices,
        vec![1, 3],
        "a filtered-out entry keeps no index, and the entries that survive keep the index their tree position gave them"
    );
}

#[test]
fn text_filter_searches_title_body_and_app() {
    let ordered = order_and_filter(
        vec![
            info("App A", "release news", None),
            info("App B", "update", Some("shipped today")),
            info("App C", "unrelated", None),
        ],
        &filter(None, Some("shipped"), None),
    );

    assert_eq!(ordered.len(), 1);
    assert_eq!(ordered[0].index, 2);
}

#[test]
fn app_filter_matches_case_insensitively() {
    let ordered = order_and_filter(
        vec![info("Windows PowerShell", "staged", None)],
        &filter(Some("windows powershell"), None, None),
    );

    assert_eq!(ordered.len(), 1);
}

#[test]
fn zero_limit_yields_nothing_and_no_limit_yields_everything() {
    let entries = vec![info("App A", "first", None), info("App B", "second", None)];

    assert!(order_and_filter(entries.clone(), &filter(None, None, Some(0))).is_empty());
    assert_eq!(
        order_and_filter(entries, &filter(None, None, None)).len(),
        2
    );
}
