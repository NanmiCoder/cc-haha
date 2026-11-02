use super::*;
use crate::AdapterError;
use crate::LocatorQuery;
use crate::context::CommandContext;
use crate::refs::refs_test_support::HomeGuard;

fn node(name: Option<&str>, value: Option<&str>, description: Option<&str>) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: Some("@e1".into()),
        role: "textfield".into(),
        identity: crate::NodeIdentity {
            retained_object: None,
            name: name.map(String::from),
            value: value.map(String::from),
            description: description.map(String::from),
            native_id: None,
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

fn search_tree(
    root: &AccessibilityNode,
    query: &LocatorQuery,
    path: &mut Vec<String>,
    matches: &mut Vec<serde_json::Value>,
    max_matches: Option<usize>,
) {
    collect_snapshot_matches(root, query, path, matches, max_matches);
}

fn query_from_args(args: &FindArgs) -> LocatorQuery {
    locator_query_from_args(args).unwrap()
}

fn no_filter() -> FindFilterArgs {
    FindFilterArgs {
        role: None,
        name: None,
        description: None,
        native_id: None,
        value: None,
        text: None,
        exact: false,
    }
}

fn no_selection() -> FindSelectionArgs {
    FindSelectionArgs {
        count: false,
        first: false,
        last: false,
        nth: None,
        limit: None,
    }
}

fn serialized_match(name: &str, value: Option<&str>, states: &[&str]) -> Value {
    serde_json::to_value(crate::locator::live_locator::LocatorMatchData {
        ref_id: Some("@e1".into()),
        role: "textfield".into(),
        name: name.into(),
        value: value.map(String::from),
        states: states.iter().map(|state| (*state).to_owned()).collect(),
        interactive: true,
        path: vec![],
    })
    .expect("a match serializes")
}

#[test]
fn unnamed_match_keeps_value_separate_from_name() {
    let unnamed = serialized_match("", Some("current value"), &[]);

    assert!(unnamed.get("name").is_none());
    assert_eq!(unnamed["value"], "current value");
}

#[test]
fn match_serializes_ref_id_contract_and_includes_states() {
    let saved = serialized_match("Save", None, &["enabled"]);

    assert_eq!(saved["name"], "Save");
    assert_eq!(saved["ref_id"], "@e1");
    assert!(saved.get("ref").is_none());
    assert_eq!(saved["states"], serde_json::json!(["enabled"]));
}

#[test]
fn text_query_matches_across_name_value_and_description() {
    let root = node(None, Some("Primary"), Some("Secondary"));
    let query = LocatorQuery {
        has_text: Some(search_text::normalize("secondary")),
        ..LocatorQuery::default()
    };

    assert!(crate::accessibility_node_matches(&root, &query));
}

#[test]
fn default_limit_caps_materialized_matches() {
    let root = AccessibilityNode {
        ref_id: None,
        role: "window".into(),
        identity: Default::default(),
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: (0..60)
            .map(|i| node(Some(&format!("Button {i}")), None, None))
            .collect(),
    };
    let query = LocatorQuery {
        has_text: Some(search_text::normalize("button")),
        ..LocatorQuery::default()
    };
    let mut matches = Vec::new();

    search_tree(
        &root,
        &query,
        &mut Vec::new(),
        &mut matches,
        Some(DEFAULT_LIMIT),
    );

    assert_eq!(matches.len(), DEFAULT_LIMIT);
}

#[test]
fn limit_conflicts_with_single_result_modes_for_batch_too() {
    let err = validate_find_mode(&FindArgs {
        app: None,
        window_id: None,
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: no_filter(),
        states: vec![],
        timeout_ms: None,
        selection: FindSelectionArgs {
            first: true,
            limit: Some(10),
            ..no_selection()
        },
    })
    .unwrap_err();

    assert_eq!(err.code(), "INVALID_ARGS");
}

fn role_node(role: &str, name: Option<&str>) -> AccessibilityNode {
    let mut n = node(name, None, None);
    n.role = role.into();
    n
}

#[test]
fn role_alias_is_preserved_until_live_validation() {
    let query = query_from_args(&FindArgs {
        app: None,
        window_id: None,
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: Some("textarea".into()),
            ..no_filter()
        },
        states: vec![],
        timeout_ms: None,
        selection: no_selection(),
    });

    assert_eq!(query.identity.role.as_deref(), Some("textarea"));

    let root = node(None, Some("doc body"), None);
    assert!(crate::accessibility_node_matches(&root, &query));
}

#[test]
fn unknown_role_is_preserved_until_validation() {
    let query = query_from_args(&FindArgs {
        app: None,
        window_id: None,
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: Some("navbar".into()),
            ..no_filter()
        },
        states: vec![],
        timeout_ms: None,
        selection: no_selection(),
    });

    assert_eq!(query.identity.role.as_deref(), Some("navbar"));

    let root = role_node("textfield", Some("body"));
    assert!(!crate::accessibility_node_matches(&root, &query));
}

#[test]
fn roles_present_hint_is_omitted_when_a_match_is_found() {
    let _guard = HomeGuard::new();
    let adapter = super::test_support::LiveFindAdapter::complete();
    let first = FindSelectionArgs {
        first: true,
        ..no_selection()
    };

    for selection in [no_selection(), first] {
        let response = execute(
            FindArgs {
                app: None,
                window_id: Some("w-1".into()),
                root: None,
                surface: crate::SnapshotSurface::Window,
                filter: FindFilterArgs {
                    role: Some("button".into()),
                    ..no_filter()
                },
                states: vec![],
                timeout_ms: None,
                selection,
            },
            &adapter,
            &CommandContext::default(),
        )
        .expect("a role query that matches should succeed");

        let found = response["matches"]
            .as_array()
            .map_or(!response["match"].is_null(), |matches| !matches.is_empty());
        assert!(found, "the button in w-1 must be found: {response}");
        assert!(response.get("roles_present").is_none());
    }
}

fn find_args_scoped_to_window(window_id: &str) -> FindArgs {
    FindArgs {
        app: None,
        window_id: Some(window_id.into()),
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            name: Some("OnlyInWindowTwo".into()),
            ..no_filter()
        },
        states: vec![],
        timeout_ms: None,
        selection: no_selection(),
    }
}

/// The names a `find` response matched, and nothing else from the envelope.
///
/// A failure message built from the whole response would carry the snapshot id
/// and the session-derived fields alongside the one thing the assertion is
/// about. Test output is not a safe place for those to travel, and a reader
/// debugging a scope failure wants the names that leaked, not a JSON tree.
fn matched_names(response: &Value) -> Vec<String> {
    response["matches"]
        .as_array()
        .expect("matches must be an array")
        .iter()
        .map(|entry| {
            entry["name"]
                .as_str()
                .map_or_else(|| "<unnamed>".to_owned(), str::to_owned)
        })
        .collect()
}

#[test]
fn find_scopes_matches_to_requested_window_id() {
    let _guard = HomeGuard::new();
    let context = CommandContext::default();
    let adapter = super::test_support::LiveFindAdapter::complete();

    let from_window_two = execute(find_args_scoped_to_window("w-2"), &adapter, &context)
        .expect("find scoped to w-2 should succeed");
    let hits = matched_names(&from_window_two);
    assert_eq!(
        hits,
        vec!["OnlyInWindowTwo".to_owned()],
        "window w-2's tree owns the only match"
    );

    let from_window_one = execute(find_args_scoped_to_window("w-1"), &adapter, &context)
        .expect("find scoped to w-1 should succeed");
    let misses = matched_names(&from_window_one);
    assert!(
        misses.is_empty(),
        "window w-1 must not surface window w-2's element \
         (window_id must not be ignored or swapped with app), leaked: {misses:?}"
    );
}

/// A budget that ran out on a large tree is not evidence of an unresponsive
/// app, and the shared timeout constructor says it is. Find overrides it with
/// the two levers a caller actually has — and only for a timeout, so every
/// other error keeps the suggestion its own constructor chose.
#[test]
fn a_traversal_timeout_names_the_budget_and_other_errors_are_untouched() {
    let timed_out = AppError::Adapter(AdapterError::timeout("traversal ran out"));
    let AppError::Adapter(renamed) = name_the_traversal_remedy(timed_out) else {
        panic!("a timeout stays an adapter error");
    };
    let suggestion = renamed.suggestion.expect("a timeout carries a suggestion");
    assert!(
        suggestion.contains("--timeout-ms"),
        "the caller must be told which budget to raise, got: {suggestion}"
    );
    assert!(
        !suggestion.contains("busy or unresponsive"),
        "a large tree is not an unresponsive app, got: {suggestion}"
    );

    let missing = AppError::Adapter(
        AdapterError::new(crate::ErrorCode::AppNotFound, "no such app")
            .with_suggestion("Launch it first"),
    );
    let AppError::Adapter(untouched) = name_the_traversal_remedy(missing) else {
        panic!("a non-timeout stays an adapter error");
    };
    assert_eq!(
        untouched.suggestion.as_deref(),
        Some("Launch it first"),
        "only a timeout is re-suggested; anything else keeps its own"
    );
}
