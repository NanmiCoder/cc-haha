use super::*;

fn app(name: &str, pid: u32) -> AppInfo {
    AppInfo {
        name: name.to_string(),
        pid: agent_desktop_core::ProcessId::new(pid),
        bundle_id: None,
        process_instance: Some(format!("instance-{pid}")),
        presentation: None,
    }
}

fn app_with_bundle(name: &str, pid: u32, bundle_id: &str) -> AppInfo {
    AppInfo {
        name: name.to_string(),
        pid: agent_desktop_core::ProcessId::new(pid),
        bundle_id: Some(bundle_id.to_string()),
        process_instance: Some(format!("instance-{pid}")),
        presentation: None,
    }
}

#[test]
fn merge_apps_does_not_duplicate_same_pid_with_different_name() {
    let mut apps = vec![app("Preview", 42)];

    merge_apps(&mut apps, vec![app("Preview Helper", 42)]).unwrap();

    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0].name, "Preview");
}

#[test]
fn merge_apps_adds_bundle_id_for_existing_pid() {
    let mut apps = vec![app("Preview", 42)];

    merge_apps(
        &mut apps,
        vec![app_with_bundle("Preview Helper", 42, "com.apple.Preview")],
    )
    .unwrap();

    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0].bundle_id.as_deref(), Some("com.apple.Preview"));
}

#[test]
fn merge_apps_keeps_distinct_pids_with_same_name() {
    let mut apps = vec![app("Terminal", 10)];

    merge_apps(&mut apps, vec![app("Terminal", 11)]).unwrap();

    assert_eq!(apps.len(), 2);
    assert_eq!(apps[1].pid, 11);
}

#[test]
fn matching_pids_returns_all_exact_name_instances() {
    let apps = vec![
        app("Terminal", 3),
        app("Terminal Helper", 4),
        app("terminal", 2),
        app("Terminal", 3),
    ];

    assert_eq!(matching_pids(&apps, "Terminal"), vec![2, 3]);
}

#[test]
fn merge_apps_rejects_pid_reuse_between_sources() {
    let mut apps = vec![app("Old App", 42)];
    let mut replacement = app("Replacement App", 42);
    replacement.process_instance = Some("replacement-generation".into());

    let error = merge_apps(&mut apps, vec![replacement]).expect_err("PID reuse must fail closed");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["kind"], "inventory_identity_race");
    assert_eq!(apps[0].name, "Old App");
}

#[test]
fn signal_inventory_rejects_even_one_missing_complete_source() {
    let error = complete_apps_from_sources(Ok(vec![app("Finder", 10)]), Err(source_error("ps")))
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    let details = error.details.unwrap();
    assert_eq!(details["complete"], false);
    assert_eq!(details["failures"].as_array().unwrap().len(), 1);
}

#[test]
fn signal_inventory_accepts_complete_successful_empty_sources() {
    let apps = complete_apps_from_sources(Ok(Vec::new()), Ok(Vec::new())).unwrap();

    assert!(apps.is_empty());
}

#[test]
fn sort_apps_orders_by_name_then_pid() {
    let mut apps = vec![app("Terminal", 3), app("Finder", 2), app("Finder", 1)];

    sort_apps(&mut apps);

    assert_eq!(
        apps.iter().map(|app| app.pid).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
}

fn source_error(source: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::AppUnresponsive,
        format!("{source} inventory failed"),
    )
}

const UNCONSUMED_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

#[test]
fn a_retryable_failure_is_retried_until_the_inventory_repeats() {
    let mut attempts = 0_u64;
    let apps = stabilize_apps_until(Instant::now() + UNCONSUMED_BUDGET, || {
        attempts += 1;
        if attempts == 1 {
            return Err(inventory_failure_fixture());
        }
        Ok(vec![app("A", 10)])
    })
    .unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(attempts, 3);
}

#[test]
fn persistent_source_failure_preserves_diagnosis_without_churn() {
    let source = inventory_failure_fixture();
    let mut attempts = 0_u64;
    let error = stabilize_apps_until(Instant::now() + UNCONSUMED_BUDGET, || {
        attempts += 1;
        if attempts == 3 {
            return Err(AdapterError::timeout("macOS app inventory timed out"));
        }
        complete_apps_from_sources(Err(source.clone()), Ok(Vec::new()))
    })
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["kind"], "application_inventory_unstable");
    assert_eq!(details["attempts"], 3);
    assert_eq!(details["churn_events"], 0);
    let failure = &details["last_failure_details"]["failures"][0];
    assert_eq!(failure["source"], "ns_workspace");
    assert_eq!(failure["code"], "APP_UNRESPONSIVE");
    assert_eq!(failure["details"]["skipped"][0]["pid"], 11);
}

fn inventory_failure_fixture() -> AdapterError {
    source_error("ns_workspace").with_details(serde_json::json!({
        "retryable":true, "skipped":[{"pid":11,"field":"activation_policy"}],
    }))
}

#[test]
fn changing_app_inventory_counts_only_observed_changes() {
    let mut attempts = 0_u64;
    let error = stabilize_apps_until(
        Instant::now() + std::time::Duration::from_millis(20),
        || {
            attempts += 1;
            Ok(vec![app(
                if attempts.is_multiple_of(2) { "A" } else { "B" },
                10,
            )])
        },
    )
    .unwrap_err();
    let details = error.details.unwrap();
    assert_eq!(details["churn_events"], attempts.saturating_sub(1));
    assert!(details.get("last_failure").is_none());
    assert!(details.get("last_failure_details").is_none());
}
