use super::*;
use serde_json::json;

fn deadline() -> Instant {
    Instant::now() + std::time::Duration::from_secs(1)
}

#[test]
fn malformed_records_are_reported_without_blocking_either_inventory() {
    let valid =
        json!({"name":"Finder", "pid":10, "launch_time":100.0, "activation_policy":"regular"});
    for (key, value, field) in [
        ("pid", json!(-1), "pid"),
        ("name", json!(" "), "application_name"),
        ("name", json!("x".repeat(16385)), "application_name"),
        ("activation_policy", json!("unknown"), "activation_policy"),
        ("launch_time", json!(-1.0), "application_launch_time"),
        ("launch_time", json!("bad"), "application_launch_time"),
        ("bundle_id", json!(42), "bundle_identifier"),
        ("bundle_id", json!("x".repeat(16385)), "bundle_identifier"),
    ] {
        let mut invalid = valid.clone();
        invalid["pid"] = json!(11);
        invalid[key] = value;
        let bytes = serde_json::to_vec(&json!({
            "applications":[invalid, valid, valid],
            "frontmost_pid":11, "frontmost_launch_time":100.0,
        }))
        .unwrap();
        let bridged = bridged_snapshot(&bytes).unwrap();
        assert_eq!(bridged.skipped[0]["field"], field);
        assert_eq!(bridged.skipped.len(), 1);
        let owners = window_owner_snapshot_from_json(&bytes, deadline());
        if key == "pid" {
            assert!(owners.is_err());
        } else {
            let owners = owners.unwrap();
            assert_eq!(owners.eligible_pids().len(), 1);
            assert!(owners.frontmost().is_none());
        }
        let apps = apps_from_json_with(
            &bytes,
            deadline(),
            |_| true,
            true,
            |pid| {
                assert_eq!(pid, 10);
                Ok(Some("instance-10".into()))
            },
        )
        .unwrap();
        assert_eq!(apps.len(), 1);
    }
}

#[test]
fn skipped_bridge_records_survive_a_remaining_inventory_failure() {
    let bytes = serde_json::to_vec(&json!({
        "applications":[{"name":"Finder", "pid":10, "launch_time":100.0, "activation_policy":"regular"}],
        "frontmost_pid":0, "frontmost_launch_time":null,
        "skipped":[{"pid":11, "field":"activation_policy"}],
    })).unwrap();
    let error = apps_from_json_with(
        &bytes,
        deadline(),
        |_| true,
        true,
        |_| Err(inventory_error("identity unavailable")),
    )
    .unwrap_err();
    assert_eq!(
        error.details.unwrap()["skipped"][0],
        json!({"pid":11,"field":"activation_policy"})
    );
}

#[test]
fn malformed_frontmost_metadata_does_not_discard_valid_owners() {
    for (pid, time, field) in [
        (json!(-1), json!(null), "frontmost_pid"),
        (json!(10), json!("bad"), "frontmost_launch_time"),
        (json!(0), json!(100.0), "frontmost_launch_time"),
    ] {
        let bytes = serde_json::to_vec(&json!({
            "applications":[{"pid":10,"name":"Finder","launch_time":100.0,"activation_policy":"regular"}],
            "frontmost_pid":pid,"frontmost_launch_time":time,
        })).unwrap();
        assert_eq!(bridged_snapshot(&bytes).unwrap().skipped[0]["field"], field);
        let owners = window_owner_snapshot_from_json(&bytes, deadline()).unwrap();
        assert!(owners.frontmost().is_none());
        assert_eq!(owners.eligible_pids().len(), 1);
    }
}

#[test]
fn skipped_records_survive_an_expired_inventory_deadline() {
    let bytes = serde_json::to_vec(&json!({
        "applications":[{"pid":10,"name":"Finder","launch_time":100.0,"activation_policy":"regular"}],
        "frontmost_pid":0,"frontmost_launch_time":null,
        "skipped":[{"pid":11,"field":"activation_policy"}],
    })).unwrap();
    let apps_error = apps_from_json_with(
        &bytes,
        Instant::now(),
        |_| true,
        true,
        |_| panic!("expired deadline must stop before identity reads"),
    )
    .unwrap_err();
    let owners_error = window_owner_snapshot_from_json(&bytes, Instant::now()).unwrap_err();
    for error in [apps_error, owners_error] {
        assert_eq!(error.code, ErrorCode::Timeout);
        assert_eq!(error.details.unwrap()["skipped"][0]["pid"], 11);
    }
}

#[test]
fn skipped_records_preserve_matching_apps_and_retry_missing_names() {
    let bytes = serde_json::to_vec(&json!({
        "applications":[{"pid":10,"name":"Finder","launch_time":100.0,"activation_policy":"regular"}],
        "frontmost_pid":0,"frontmost_launch_time":null,
        "skipped":[{"pid":11,"field":"application_name"}],
    })).unwrap();
    let capture = |name: &str| {
        apps_inventory_from_json_with(
            &bytes,
            deadline(),
            |app| app.name == name,
            false,
            |_| Ok(Some("instance-10".into())),
        )
    };
    let apps = crate::system::app::app_inventory::scoped_apps_from_sources(
        capture("Finder"),
        Ok(Vec::new()),
    )
    .unwrap();
    assert_eq!(apps[0].name, "Finder");
    let mut attempts = 0_u64;
    let error = crate::system::app::app_inventory::stabilize_apps_until(
        Instant::now() + std::time::Duration::from_secs(5),
        || {
            attempts += 1;
            if attempts == 3 {
                return Err(AdapterError::timeout("macOS app inventory timed out"));
            }
            crate::system::app::app_inventory::scoped_apps_from_sources(
                capture("Missing"),
                Ok(Vec::new()),
            )
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.is_explicitly_retryable());
    let details = error.details.unwrap();
    assert_eq!(details["attempts"], 3);
    assert_eq!(
        details["last_failure_details"]["skipped"][0],
        json!({"pid":11,"field":"application_name"})
    );
    let owners = window_owner_snapshot_from_json(&bytes, deadline()).unwrap();
    owners.require_match("Finder").unwrap();
    let error = owners.require_match("Missing").unwrap_err();
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["skipped"][0]["pid"], 11);
}

#[test]
fn workspace_identity_aliases_do_not_make_missing_apps_retryable() {
    let app =
        json!({"name":"Finder", "pid":10, "launch_time":100.0, "activation_policy":"regular"});
    let mut alias = app.clone();
    alias["name"] = json!("Finder alias");
    let bytes = serde_json::to_vec(&json!({
        "applications":[app, alias], "frontmost_pid":10, "frontmost_launch_time":100.0,
    }))
    .unwrap();
    let inventory = apps_inventory_from_json_with(
        &bytes,
        deadline(),
        |_| true,
        true,
        |_| Ok(Some("instance-10".into())),
    )
    .unwrap();
    assert_eq!(inventory.apps.len(), 1);
    require_complete(&inventory.skipped).unwrap();
    let owners = window_owner_snapshot_from_json(&bytes, deadline()).unwrap();
    owners.require_match("Missing").unwrap();
    assert_eq!(owners.frontmost().unwrap().pid, 10);
}

#[test]
fn conflicting_workspace_records_remain_incomplete() {
    let app =
        json!({"name":"Finder", "pid":10, "launch_time":100.0, "activation_policy":"regular"});
    for (field, value) in [
        ("launch_time", json!(101.0)),
        ("activation_policy", json!("accessory")),
        ("bundle_id", json!("other.bundle")),
    ] {
        let mut conflicting = app.clone();
        conflicting[field] = value;
        let bytes = serde_json::to_vec(&json!({
            "applications":[app, conflicting], "frontmost_pid":0, "frontmost_launch_time":null,
        }))
        .unwrap();
        let inventory = apps_inventory_from_json_with(
            &bytes,
            deadline(),
            |_| true,
            true,
            |_| Ok(Some("instance-10".into())),
        )
        .unwrap();
        assert!(require_complete(&inventory.skipped).is_err(), "{field}");
    }
}
