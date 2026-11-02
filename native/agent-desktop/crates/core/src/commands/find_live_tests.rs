use super::test_support::{FRAMED_LABEL, LiveFindAdapter, framed_label_screen_bounds};
use super::*;
use crate::{
    AppError,
    adapter::{ObservationOps, WindowFilter},
    locator::live_locator::{
        LocatorMaterialization, LocatorResolveRequest, LocatorSelection, ObservationRoot,
        require_unique, resolve_query,
    },
    refs::refs_store::RefStore,
    refs::refs_test_support::HomeGuard,
};

fn named_find(window_id: &str, name: &str) -> FindArgs {
    FindArgs {
        app: None,
        window_id: Some(window_id.into()),
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            name: Some(name.into()),
            role: None,
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: false,
        },
        states: Vec::new(),
        timeout_ms: None,
        selection: FindSelectionArgs {
            count: false,
            first: false,
            last: false,
            nth: None,
            limit: None,
        },
    }
}

fn unfiltered_find(window_id: &str, selection: FindSelectionArgs) -> FindArgs {
    FindArgs {
        app: None,
        window_id: Some(window_id.into()),
        root: None,
        surface: crate::SnapshotSurface::Window,
        filter: FindFilterArgs {
            role: None,
            name: None,
            description: None,
            native_id: None,
            value: None,
            text: None,
            exact: false,
        },
        states: Vec::new(),
        timeout_ms: None,
        selection,
    }
}

#[test]
fn execute_uses_live_locator_tree_and_persists_its_full_refmap() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();

    let response = execute(
        named_find("w-2", "OnlyInWindowTwo"),
        &adapter,
        &CommandContext::default(),
    )
    .expect("live find should succeed");

    let matches = response["matches"].as_array().expect("matches array");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["name"], "OnlyInWindowTwo");
    let snapshot_id = response["snapshot_id"]
        .as_str()
        .expect("find refs must carry their snapshot namespace");
    assert_eq!(matches[0]["ref_id"], format!("@{snapshot_id}:e1"));
    assert_eq!(
        RefStore::new()
            .unwrap()
            .load_snapshot(snapshot_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(RefStore::new().unwrap().load_latest().unwrap().len(), 1);
}

#[test]
fn a_context_match_shows_the_screen_rectangle_not_the_window_rectangle_a_ref_stores() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::with_framed_label();

    let response = execute(
        named_find("w-1", FRAMED_LABEL),
        &adapter,
        &CommandContext::default(),
    )
    .expect("live find should succeed");

    let found = &response["matches"][0];
    assert_eq!(found["name"], FRAMED_LABEL);
    assert!(found["ref_id"].is_null());
    assert_eq!(
        found["bounds"],
        serde_json::json!(framed_label_screen_bounds())
    );
}

#[test]
fn sequential_window_finds_return_distinct_ref_namespaces() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();

    let first = execute(
        named_find("w-1", "OnlyInWindowOne"),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    let second = execute(
        named_find("w-2", "OnlyInWindowTwo"),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();

    let first_id = first["snapshot_id"].as_str().unwrap();
    let second_id = second["snapshot_id"].as_str().unwrap();
    assert_ne!(first_id, second_id);
    let store = RefStore::new().unwrap();
    assert_eq!(
        store
            .load_snapshot(first_id)
            .unwrap()
            .get("@e1")
            .unwrap()
            .process
            .pid,
        101
    );
    assert_eq!(
        store
            .load_snapshot(second_id)
            .unwrap()
            .get("@e1")
            .unwrap()
            .process
            .pid,
        102
    );
}

#[test]
fn execute_rejects_an_incomplete_live_traversal_with_structured_evidence() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::incomplete();

    let error = execute(
        named_find("w-1", "missing"),
        &adapter,
        &CommandContext::default(),
    )
    .expect_err("an incomplete zero-match result is not authoritative");

    assert_eq!(error.code(), "TIMEOUT");
    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(
        error.details.as_ref().unwrap()["kind"],
        "locator_incomplete"
    );
    assert_eq!(error.details.as_ref().unwrap()["observed_matches"], 0);
}

#[test]
fn count_uses_live_evidence_without_creating_a_snapshot() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();
    let selection = FindSelectionArgs {
        count: true,
        first: false,
        last: false,
        nth: None,
        limit: None,
    };

    let response = execute(
        unfiltered_find("w-2", selection),
        &adapter,
        &CommandContext::default(),
    )
    .expect("live count should succeed");

    assert_eq!(response["count"], 2);
    assert!(response.get("snapshot_id").is_none());
    assert_eq!(
        RefStore::new().unwrap().load_latest().unwrap_err().code(),
        "SNAPSHOT_NOT_FOUND"
    );
}

#[test]
fn empty_live_role_result_reports_observed_roles() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::with_framed_label();
    let mut args = named_find("w-1", "missing");
    args.filter.name = None;
    args.filter.role = Some("toolbar".into());

    let response = execute(args, &adapter, &CommandContext::default())
        .expect("complete empty role query should succeed");

    let roles = response["roles_present"]
        .as_array()
        .expect("empty role result should include observed roles");
    assert!(roles.iter().any(|role| role == "button"));
    assert!(roles.iter().any(|role| role == "statictext"));
    assert!(roles.iter().any(|role| role == "window"));
    assert!(!roles.iter().any(|role| role == "toolbar"));
}

#[test]
fn an_unknown_role_is_refused_unsent_and_points_at_the_roles_a_snapshot_prints() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();
    let mut args = named_find("w-1", "missing");
    args.filter.name = None;
    args.filter.role = Some("nosuchrole".into());

    let error = execute(args, &adapter, &CommandContext::default())
        .expect_err("a role no snapshot prints is an argument error");
    let AppError::Adapter(error) = error else {
        panic!("a refused role is an adapter error");
    };

    assert_eq!(error.code, crate::ErrorCode::InvalidArgs);
    assert!(error.message.contains("nosuchrole"), "{}", error.message);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), crate::RetryDisposition::Safe);
    let suggestion = error
        .suggestion
        .expect("a refused role carries a suggestion");
    assert!(
        suggestion.contains("snapshot") && suggestion.contains("'role'"),
        "the caller must learn where valid role names come from, got: {suggestion}"
    );
}

#[test]
fn ordinal_modes_preserve_live_document_order() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();
    let first = FindSelectionArgs {
        count: false,
        first: true,
        last: false,
        nth: None,
        limit: None,
    };
    let last = FindSelectionArgs {
        count: false,
        first: false,
        last: true,
        nth: None,
        limit: None,
    };

    let first_response = execute(
        unfiltered_find("w-2", first),
        &adapter,
        &CommandContext::default(),
    )
    .expect("first should succeed");
    let last_response = execute(
        unfiltered_find("w-2", last),
        &adapter,
        &CommandContext::default(),
    )
    .expect("last should succeed");

    assert_eq!(first_response["match"]["name"], "Second");
    assert_eq!(last_response["match"]["name"], "OnlyInWindowTwo");
}

#[test]
fn strict_live_resolution_of_two_matches_is_ambiguous_with_an_exact_count() {
    let adapter = LiveFindAdapter::complete();
    let windows = adapter
        .list_windows(
            &WindowFilter::default(),
            crate::Deadline::standard().unwrap(),
        )
        .unwrap();
    let request = LocatorResolveRequest {
        selection: LocatorSelection::Strict,
        deadline: crate::Deadline::from_duration(std::time::Duration::from_secs(1)).unwrap(),
        max_raw_depth: 50,
        surface: None,
        materialization: LocatorMaterialization::FullRefMap,
    };
    let resolution = resolve_query(
        &adapter,
        &LocatorQuery::default(),
        ObservationRoot::Window(&windows[1]),
        &request,
    )
    .expect("live resolution should succeed");

    let error = require_unique(resolution)
        .err()
        .expect("two matches must be ambiguous");

    assert_eq!(error.code(), "AMBIGUOUS_TARGET");
    let AppError::Adapter(error) = error else {
        panic!("expected adapter error");
    };
    assert_eq!(error.details.as_ref().unwrap()["candidate_count"], 2);
    assert_eq!(
        error.details.as_ref().unwrap()["candidate_count_exact"],
        true
    );
}

/// Proves the remedy is wired, not merely written. A budget of zero expires
/// before the traversal can answer, so this drives the whole command and fails
/// if the mapping is ever dropped from `execute` — which a test calling the
/// mapping function directly would not notice.
#[test]
fn a_timed_out_find_reaches_the_caller_with_the_budget_named() {
    let _guard = HomeGuard::new();
    let adapter = LiveFindAdapter::complete();
    let mut args = named_find("w-2", "OnlyInWindowTwo");
    args.timeout_ms = Some(0);

    let error = execute(args, &adapter, &CommandContext::default())
        .expect_err("a zero budget cannot produce an authoritative answer");
    let AppError::Adapter(error) = error else {
        panic!("find's timeout is an adapter error");
    };

    assert_eq!(error.code, crate::ErrorCode::Timeout);
    let suggestion = error.suggestion.expect("a timeout carries a suggestion");
    assert!(
        suggestion.contains("--timeout-ms"),
        "the caller must reach the budget lever through the command, got: {suggestion}"
    );
}
