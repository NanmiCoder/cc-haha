use super::*;
use std::os::unix::process::ExitStatusExt;

#[test]
fn app_name_from_command_extracts_app_bundle_name() {
    assert_eq!(
        app_name_from_command("/Applications/Finder.app/Contents/MacOS/Finder").as_deref(),
        Some("Finder")
    );
}

#[test]
fn app_name_from_command_rejects_framework_helpers() {
    assert_eq!(
        app_name_from_command(
            "/Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper",
        ),
        None
    );
}

#[test]
fn app_name_from_command_rejects_plugin_helpers() {
    assert_eq!(
        app_name_from_command(
            "/Applications/Foo.app/Contents/PlugIns/Foo Plugin.app/Contents/MacOS/Foo Plugin",
        ),
        None
    );
}

#[test]
fn app_name_from_command_rejects_xpc_services() {
    assert_eq!(
        app_name_from_command("/Applications/Foo.app/Contents/XPCServices/Worker.xpc/Worker"),
        None
    );
}

#[test]
fn app_name_from_command_rejects_app_extensions() {
    assert_eq!(
        app_name_from_command("/Applications/Foo.app/Contents/PlugIns/Share.appex/Share"),
        None
    );
}

#[test]
fn app_name_from_command_rejects_empty_app_name() {
    assert_eq!(
        app_name_from_command("/Applications/.app/Contents/MacOS/Foo"),
        None
    );
}

#[test]
fn successful_empty_ps_output_is_a_real_empty_inventory() {
    let output = Output {
        status: std::process::ExitStatus::from_raw(0),
        stdout: Vec::new(),
        stderr: Vec::new(),
    };

    let apps = apps_from_output(output).unwrap();

    assert!(apps.is_empty());
}

#[test]
fn failed_ps_output_is_not_an_empty_inventory() {
    let output = Output {
        status: std::process::ExitStatus::from_raw(256),
        stdout: Vec::new(),
        stderr: b"resource temporarily unavailable".to_vec(),
    };

    let error = apps_from_output(output).unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.details.unwrap()["source"], "ps");
}

#[test]
fn expired_ps_deadline_is_rejected_before_starting_a_process() {
    let error = list_apps_until(Instant::now()).unwrap_err();

    assert_eq!(error.code.as_str(), "TIMEOUT");
}

#[test]
fn malformed_ps_line_is_not_silently_dropped() {
    let error = parse_apps("not-a-pid /Applications/Mail.app/Contents/MacOS/Mail").unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}

#[test]
fn valid_non_app_processes_still_produce_successful_empty_inventory() {
    let apps = parse_apps("1 /sbin/launchd\n2 /usr/libexec/logd").unwrap();

    assert!(apps.is_empty());
}

#[test]
fn inaccessible_cross_uid_process_is_skipped() {
    let apps = parse_apps(
        "42 /Applications/Visible.app/Contents/MacOS/Visible\n43 /Applications/Private.app/Contents/MacOS/Private",
    )
    .unwrap();
    let enriched = enrich_process_instances(apps, |pid| {
        if pid == 43 {
            Err(
                AdapterError::new(ErrorCode::PermDenied, "permission denied").with_details(
                    serde_json::json!({
                        "kind": "process_identity_permission",
                        "retryable": false,
                    }),
                ),
            )
        } else {
            Ok(Some(format!("instance-{pid}")))
        }
    })
    .unwrap();

    assert_eq!(enriched.len(), 1);
    assert_eq!(enriched[0].name, "Visible");
    assert_eq!(enriched[0].process_instance.as_deref(), Some("instance-42"));
}

#[test]
fn process_that_exits_during_identity_enrichment_is_skipped() {
    let apps = parse_apps(
        "42 /Applications/Visible.app/Contents/MacOS/Visible\n43 /Applications/Exited.app/Contents/MacOS/Exited",
    )
    .unwrap();
    let enriched = enrich_process_instances(apps, |pid| {
        if pid == 43 {
            Ok(None)
        } else {
            Ok(Some(format!("instance-{pid}")))
        }
    })
    .unwrap();

    assert_eq!(enriched.len(), 1);
    assert_eq!(enriched[0].name, "Visible");
}

#[test]
fn process_identity_failure_other_than_cross_uid_permission_is_not_hidden() {
    let apps = parse_apps("42 /Applications/Broken.app/Contents/MacOS/Broken").unwrap();
    let error = enrich_process_instances(apps, |_| {
        Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "identity unavailable",
        ))
    })
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}
