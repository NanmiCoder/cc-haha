use super::*;

fn deadline() -> Instant {
    Instant::now() + std::time::Duration::from_secs(1)
}

#[test]
fn malformed_bridge_payload_is_retryable_inventory_failure() {
    let error = apps_from_json(b"not-json", deadline()).unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["retryable"], true);
}

#[test]
fn owner_snapshot_includes_regular_and_accessory_but_excludes_prohibited() {
    let bytes = br#"{
        "applications":[
            {"name":"Mail","pid":10,"bundle_id":"com.apple.mail","launch_time":100.25,"activation_policy":"regular"},
            {"name":"Palette","pid":11,"launch_time":101.5,"activation_policy":"accessory"},
            {"name":"Daemon","pid":12,"launch_time":102.75,"activation_policy":"prohibited"}
        ],
        "frontmost_pid":11,
        "frontmost_launch_time":101.5
    }"#;
    let snapshot = window_owner_snapshot_from_json(bytes, deadline()).unwrap();

    assert_eq!(snapshot.eligible_pids().len(), 2);
    assert!(snapshot.eligible_pids().contains(&10));
    assert!(snapshot.eligible_pids().contains(&11));
    assert!(snapshot.owner(12).is_none());
    assert_eq!(snapshot.owner(10).unwrap().name, "Mail");
    assert_eq!(
        snapshot.owner(10).unwrap().bundle_id.as_deref(),
        Some("com.apple.mail")
    );
    assert_eq!(
        snapshot.owner(10).unwrap().activation_policy,
        ActivationPolicy::Regular
    );
    assert_eq!(
        snapshot.owner(11).unwrap().activation_policy,
        ActivationPolicy::Accessory
    );
    assert_eq!(snapshot.frontmost().unwrap().pid, 11);
    assert_eq!(snapshot.frontmost().unwrap().launch_time, Some(101.5));
}

#[test]
fn owner_snapshot_matches_visible_app_name_and_bundle_id() {
    let bytes = br#"{
        "applications":[
            {"name":"\u200eWhatsApp","pid":10,"bundle_id":"net.whatsapp.WhatsApp","launch_time":100.25,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let snapshot = window_owner_snapshot_from_json(bytes, deadline()).unwrap();

    assert_eq!(
        snapshot
            .matching_pids("WhatsApp")
            .into_iter()
            .collect::<Vec<_>>(),
        [10]
    );
    assert_eq!(
        snapshot
            .matching_pids("net.whatsapp.WhatsApp")
            .into_iter()
            .collect::<Vec<_>>(),
        [10]
    );
}

#[test]
fn non_launchservices_accessory_keeps_optional_launch_identity() {
    let bytes = br#"{
        "applications":[
            {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"},
            {"name":"Palette","pid":11,"launch_time":null,"activation_policy":"accessory"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let snapshot = window_owner_snapshot_from_json(bytes, deadline()).unwrap();

    assert!(snapshot.eligible_pids().contains(&11));
    assert_eq!(snapshot.owner(11).unwrap().launch_time, None);
}

#[test]
fn frontmost_requires_an_exact_owner_generation_match() {
    let bytes = br#"{
        "applications":[
            {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.2500001
    }"#;
    let error = window_owner_snapshot_from_json(bytes, deadline()).unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["source"], "ns_workspace");
}

#[test]
fn zero_and_null_are_the_explicit_missing_frontmost_pair() {
    let bytes = br#"{
        "applications":[
            {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"}
        ],
        "frontmost_pid":0,
        "frontmost_launch_time":null
    }"#;
    let snapshot = window_owner_snapshot_from_json(bytes, deadline()).unwrap();

    assert!(snapshot.frontmost().is_none());
}

#[test]
fn non_launchservices_frontmost_app_uses_live_process_identity() {
    let bytes = br#"{
        "applications":[
            {"name":"Direct","pid":10,"launch_time":null,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":null
    }"#;
    let snapshot = window_owner_snapshot_from_json(bytes, deadline()).unwrap();

    assert_eq!(snapshot.frontmost().unwrap().pid, 10);
    assert_eq!(snapshot.frontmost().unwrap().launch_time, None);
}

#[test]
fn incomplete_or_contradictory_frontmost_identity_is_rejected() {
    for bytes in [
        br#"{"applications":[],"frontmost_pid":0}"#.as_slice(),
        br#"{"applications":[],"frontmost_pid":10,"frontmost_launch_time":null}"#.as_slice(),
    ] {
        let error = window_owner_snapshot_from_json(bytes, deadline()).unwrap_err();

        assert_eq!(error.code, ErrorCode::AppUnresponsive);
    }
}

#[test]
fn duplicate_owner_pid_is_skipped_for_same_or_different_generation() {
    for launch_time in [100.25, 101.5] {
        let bytes = format!(
            r#"{{
                "applications":[
                    {{"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"}},
                    {{"name":"Palette","pid":10,"launch_time":{launch_time},"activation_policy":"accessory"}}
                ],
                "frontmost_pid":0,
                "frontmost_launch_time":null
            }}"#
        );
        let snapshot = window_owner_snapshot_from_json(bytes.as_bytes(), deadline()).unwrap();
        assert_eq!(snapshot.owners.len(), 1);
        assert_eq!(snapshot.owner(10).unwrap().name, "Mail");
    }
}

#[test]
fn owner_snapshot_equality_detects_generation_and_frontmost_changes() {
    let baseline = window_owner_snapshot_from_json(
        br#"{
            "applications":[
                {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"},
                {"name":"Palette","pid":11,"launch_time":101.5,"activation_policy":"accessory"}
            ],
            "frontmost_pid":10,
            "frontmost_launch_time":100.25
        }"#,
        deadline(),
    )
    .unwrap();
    let reordered = window_owner_snapshot_from_json(
        br#"{
            "applications":[
                {"name":"Palette","pid":11,"launch_time":101.5,"activation_policy":"accessory"},
                {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"}
            ],
            "frontmost_pid":10,
            "frontmost_launch_time":100.25
        }"#,
        deadline(),
    )
    .unwrap();
    let changed = window_owner_snapshot_from_json(
        br#"{
            "applications":[
                {"name":"Mail","pid":10,"launch_time":100.5,"activation_policy":"regular"},
                {"name":"Palette","pid":11,"launch_time":101.5,"activation_policy":"accessory"}
            ],
            "frontmost_pid":10,
            "frontmost_launch_time":100.5
        }"#,
        deadline(),
    )
    .unwrap();

    assert_eq!(baseline, reordered);
    assert!(baseline.same_generation(&reordered));
    assert_ne!(baseline, changed);
    assert!(!baseline.same_generation(&changed));
}

#[test]
fn app_inventory_labels_menu_bar_apps_and_drops_headless_services() {
    let bytes = br#"{
        "applications":[
            {"name":"Mail","pid":10,"launch_time":100.25,"activation_policy":"regular"},
            {"name":"Palette","pid":11,"launch_time":101.5,"activation_policy":"accessory"},
            {"name":"Daemon","pid":12,"launch_time":102.75,"activation_policy":"prohibited"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let mut probed = Vec::new();
    let apps = apps_from_json_with(
        bytes,
        deadline(),
        |_| true,
        true,
        |pid| {
            probed.push(pid);
            Ok(Some(format!("instance-{pid}")))
        },
    )
    .unwrap();

    assert_eq!(probed, [10, 11]);
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0].name, "Mail");
    assert_eq!(
        apps[0].presentation,
        Some(agent_desktop_core::AppPresentation::Foreground)
    );
    assert_eq!(apps[1].name, "Palette");
    assert_eq!(
        apps[1].presentation,
        Some(agent_desktop_core::AppPresentation::Background)
    );
}

#[test]
fn expired_workspace_deadline_is_rejected_before_native_reads() {
    let error = list_apps_inventory_until(Instant::now()).unwrap_err();

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

#[test]
fn scoped_lookup_never_probes_unrelated_applications() {
    let bytes = br#"{
        "applications":[
            {"name":"Target","pid":10,"launch_time":100.25,"activation_policy":"regular"},
            {"name":"Other","pid":418,"launch_time":101.5,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let mut probed = Vec::new();
    let apps = apps_from_json_with(
        bytes,
        deadline(),
        |app| app.name == "Target",
        false,
        |pid| {
            probed.push(pid);
            if pid == 418 {
                Err(AdapterError::permission_denied())
            } else {
                Ok(Some(format!("instance-{pid}")))
            }
        },
    )
    .unwrap();

    assert_eq!(probed, [10]);
    assert_eq!(apps[0].process_instance.as_deref(), Some("instance-10"));
}

#[test]
fn scoped_lookup_propagates_selected_identity_denial() {
    let bytes = br#"{
        "applications":[
            {"name":"Target","pid":418,"launch_time":100.25,"activation_policy":"regular"}
        ],
        "frontmost_pid":418,
        "frontmost_launch_time":100.25
    }"#;
    let error = apps_from_json_with(
        bytes,
        deadline(),
        |_| true,
        false,
        |_| Err(AdapterError::permission_denied()),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermDenied);
}

#[test]
fn scoped_lookup_preserves_all_same_name_processes() {
    let bytes = br#"{
        "applications":[
            {"name":"Target","pid":10,"launch_time":100.25,"activation_policy":"regular"},
            {"name":"target","pid":11,"launch_time":101.5,"activation_policy":"regular"},
            {"name":"Other","pid":12,"launch_time":102.75,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let apps = apps_from_json_with(
        bytes,
        deadline(),
        |app| app.name.eq_ignore_ascii_case("Target"),
        false,
        |pid| Ok(Some(format!("instance-{pid}"))),
    )
    .unwrap();

    assert_eq!(apps.iter().map(|app| app.pid).collect::<Vec<_>>(), [10, 11]);
}

fn cross_uid_identity_denial() -> AdapterError {
    AdapterError::new(
        ErrorCode::PermDenied,
        "Permission denied reading process identity for pid 526",
    )
    .with_details(serde_json::json!({
        "kind": "process_identity_permission",
        "source": "libproc",
        "operation": "PROC_PIDTBSDINFO",
        "pid": 526,
    }))
}

#[test]
fn complete_inventory_skips_apps_owned_by_another_uid() {
    let bytes = br#"{
        "applications":[
            {"name":"Finder","pid":10,"launch_time":100.25,"activation_policy":"regular"},
            {"name":"FoxitPDFReaderUpdateService","pid":526,"launch_time":90.0,"activation_policy":"accessory"},
            {"name":"Safari","pid":12,"launch_time":102.75,"activation_policy":"regular"}
        ],
        "frontmost_pid":10,
        "frontmost_launch_time":100.25
    }"#;
    let apps = apps_from_json_with(
        bytes,
        deadline(),
        |_| true,
        true,
        |pid| {
            if pid == 526 {
                Err(cross_uid_identity_denial())
            } else {
                Ok(Some(format!("instance-{pid}")))
            }
        },
    )
    .unwrap();

    let pids: Vec<u32> = apps.iter().map(|app| u32::from(app.pid)).collect();
    assert_eq!(pids, [10, 12]);
}

#[test]
fn scoped_lookup_still_reports_cross_uid_denial_of_the_selected_app() {
    let bytes = br#"{
        "applications":[
            {"name":"Target","pid":526,"launch_time":100.25,"activation_policy":"regular"}
        ],
        "frontmost_pid":526,
        "frontmost_launch_time":100.25
    }"#;
    let error = apps_from_json_with(
        bytes,
        deadline(),
        |_| true,
        false,
        |_| Err(cross_uid_identity_denial()),
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::PermDenied);
}
