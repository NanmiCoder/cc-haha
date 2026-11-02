use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, AppInfo};
use std::sync::atomic::{AtomicU32, Ordering};

struct AppsAdapter;

struct DeadlineAdapter {
    expected_timeout_ms: u64,
    app_listings: AtomicU32,
    window_listings: AtomicU32,
}

impl DeadlineAdapter {
    fn new(expected_timeout_ms: u64) -> Self {
        Self {
            expected_timeout_ms,
            app_listings: AtomicU32::new(0),
            window_listings: AtomicU32::new(0),
        }
    }
}

impl ObservationOps for AppsAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(vec![
            AppInfo {
                name: "Finder".into(),
                pid: crate::ProcessId::new(1),
                bundle_id: Some("com.apple.finder".into()),
                process_instance: Some("test-instance".into()),
                presentation: None,
            },
            AppInfo {
                name: "TextEdit".into(),
                pid: crate::ProcessId::new(2),
                bundle_id: Some("com.apple.TextEdit".into()),
                process_instance: Some("test-instance".into()),
                presentation: None,
            },
        ])
    }
}

impl ObservationOps for DeadlineAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        self.app_listings.fetch_add(1, Ordering::SeqCst);
        assert_eq!(deadline.timeout_ms(), self.expected_timeout_ms);
        Ok(Vec::new())
    }
    fn list_windows(
        &self,
        _: &crate::WindowFilter,
        deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        self.window_listings.fetch_add(1, Ordering::SeqCst);
        assert_eq!(deadline.timeout_ms(), self.expected_timeout_ms);
        Ok(Vec::new())
    }
}
impl ActionOps for DeadlineAdapter {}
impl InputOps for DeadlineAdapter {}
impl SystemOps for DeadlineAdapter {}

impl ActionOps for AppsAdapter {}

impl InputOps for AppsAdapter {}

impl SystemOps for AppsAdapter {}

#[test]
fn app_filter_matches_by_name_case_insensitively() {
    let value = execute(
        ListAppsArgs {
            app: Some("text".into()),
            timeout_ms: None,
        },
        &AppsAdapter,
    )
    .unwrap();

    let apps = value["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["name"], "TextEdit");
}

#[test]
fn listing_timeout_reaches_both_adapter_deadlines() {
    for timeout_ms in [None, Some(37), Some(8000)] {
        let adapter =
            DeadlineAdapter::new(timeout_ms.unwrap_or(crate::DEFAULT_OPERATION_TIMEOUT_MS));
        execute(
            ListAppsArgs {
                app: None,
                timeout_ms,
            },
            &adapter,
        )
        .unwrap();
        assert!(adapter.app_listings.load(Ordering::SeqCst) >= 1);
        crate::commands::list_windows::execute(
            crate::commands::list_windows::ListWindowsArgs {
                app: None,
                timeout_ms,
            },
            &adapter,
        )
        .unwrap();
        assert!(adapter.window_listings.load(Ordering::SeqCst) >= 1);
    }
}

struct IncompleteAdapter;
impl ObservationOps for IncompleteAdapter {
    fn list_apps_inventory(
        &self,
        deadline: crate::Deadline,
    ) -> Result<crate::AppInventory, AdapterError> {
        Ok(crate::AppInventory {
            apps: AppsAdapter.list_apps(deadline)?,
            skipped: vec![json!({"pid":11,"field":"application_name"})],
        })
    }
}
impl ActionOps for IncompleteAdapter {}
impl InputOps for IncompleteAdapter {}
impl SystemOps for IncompleteAdapter {}

#[test]
fn list_apps_marks_skipped_records_even_when_filtered_to_no_matches() {
    for app in [None, Some("Missing".into())] {
        let value = execute(
            ListAppsArgs {
                app,
                timeout_ms: None,
            },
            &IncompleteAdapter,
        )
        .unwrap();
        assert_eq!(value["complete"], false);
        assert_eq!(
            value["skipped"],
            json!([{"pid":11,"field":"application_name"}])
        );
    }
    let value = execute(
        ListAppsArgs {
            app: None,
            timeout_ms: None,
        },
        &AppsAdapter,
    )
    .unwrap();
    assert!(value.get("complete").is_none());
    assert!(value.get("skipped").is_none());
}

struct AliasAdapter;
impl ObservationOps for AliasAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        AppsAdapter.list_apps(deadline)
    }
    fn list_apps_scoped(
        &self,
        name: &str,
        _bundle_id: Option<&str>,
        deadline: crate::Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        let mut apps = self.list_apps(deadline)?;
        apps.retain(|app| name == "org.example.Files" && app.name == "Finder");
        Ok(apps)
    }
}
impl ActionOps for AliasAdapter {}
impl InputOps for AliasAdapter {}
impl SystemOps for AliasAdapter {}

#[test]
fn app_filter_accepts_the_adapter_alias_for_a_listed_app() {
    let value = execute(
        ListAppsArgs {
            app: Some("org.example.Files".into()),
            timeout_ms: None,
        },
        &AliasAdapter,
    )
    .unwrap();

    let apps = value["apps"].as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["name"], "Finder");
}

struct FailingScopeAdapter(AdapterError);
impl ObservationOps for FailingScopeAdapter {
    fn list_apps(&self, deadline: crate::Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        AppsAdapter.list_apps(deadline)
    }
    fn list_apps_scoped(
        &self,
        _name: &str,
        _bundle_id: Option<&str>,
        _deadline: crate::Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        Err(self.0.clone())
    }
}
impl ActionOps for FailingScopeAdapter {}
impl InputOps for FailingScopeAdapter {}
impl SystemOps for FailingScopeAdapter {}

fn filtered_args() -> ListAppsArgs {
    ListAppsArgs {
        app: Some("text".into()),
        timeout_ms: None,
    }
}

#[test]
fn app_filter_propagates_a_scoped_listing_failure() {
    let adapter = FailingScopeAdapter(AdapterError::new(
        crate::ErrorCode::Timeout,
        "scoped listing timed out",
    ));

    let error = execute(filtered_args(), &adapter).unwrap_err();

    assert_eq!(error.code(), "TIMEOUT");
}

#[test]
fn app_filter_ignores_a_scoped_listing_that_is_not_supported() {
    let adapter = FailingScopeAdapter(AdapterError::not_supported("list_apps_scoped"));

    let value = execute(filtered_args(), &adapter).unwrap();

    assert_eq!(value["apps"].as_array().unwrap().len(), 1);
}
