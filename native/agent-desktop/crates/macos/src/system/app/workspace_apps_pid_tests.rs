use super::*;

fn deadline() -> Instant {
    Instant::now() + std::time::Duration::from_secs(1)
}

fn snapshot_with(application_pid: i32, frontmost_pid: i32) -> String {
    format!(
        r#"{{
            "applications":[
                {{"name":"Mail","pid":{application_pid},"launch_time":100.25,"activation_policy":"regular"}}
            ],
            "frontmost_pid":{frontmost_pid},
            "frontmost_launch_time":null
        }}"#
    )
}

#[test]
fn owner_snapshot_skips_non_positive_application_pid() {
    for pid in [0, -1] {
        let bytes = snapshot_with(pid, 0);
        let snapshot = window_owner_snapshot_from_json(bytes.as_bytes(), deadline()).unwrap();
        assert!(snapshot.eligible_pids().is_empty());
    }
}

#[test]
fn app_listing_skips_non_positive_application_pid() {
    for pid in [0, -1] {
        let bytes = snapshot_with(pid, 0);
        let apps = apps_from_json(bytes.as_bytes(), deadline()).unwrap();
        assert!(apps.is_empty());
    }
}
