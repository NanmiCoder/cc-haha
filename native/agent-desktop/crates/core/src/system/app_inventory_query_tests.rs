use crate::{
    ActionOps, AdapterError, AppInfo, AppInventory, AppInventoryQuery, Deadline, InputOps,
    ObservationOps, SystemOps,
};

struct FilteredInventory;

impl ObservationOps for FilteredInventory {
    fn query_app_inventory(
        &self,
        query: AppInventoryQuery<'_>,
        _deadline: Deadline,
    ) -> Result<AppInventory, AdapterError> {
        match query {
            AppInventoryQuery::NameOrAlias(name) => assert_eq!(name, "Example"),
            AppInventoryQuery::Exact { name, bundle_id } => {
                assert_eq!(name, "Example");
                assert!(bundle_id.is_none() || bundle_id == Some("org.example.editor"));
            }
            AppInventoryQuery::All => panic!("unrelated applications must not be enriched"),
        }
        Ok(AppInventory {
            apps: vec![app()],
            skipped: Vec::new(),
        })
    }
}

impl ActionOps for FilteredInventory {}
impl InputOps for FilteredInventory {}
impl SystemOps for FilteredInventory {}

fn app() -> AppInfo {
    AppInfo {
        name: "Example".into(),
        pid: crate::ProcessId::new(42),
        bundle_id: Some("org.example.editor".into()),
        process_instance: Some("generation".into()),
        presentation: None,
    }
}

#[test]
fn filtered_inventory_serves_listing_lookup_and_mutation_without_global_discovery() {
    let listed = crate::commands::list_apps::execute(
        crate::commands::list_apps::ListAppsArgs {
            app: Some("Example".into()),
            timeout_ms: None,
        },
        &FilteredInventory,
    )
    .unwrap();
    assert_eq!(listed["apps"][0]["pid"], 42);
    let resolved = crate::system::app_lookup::resolve_app(
        Some("Example"),
        &FilteredInventory,
        Deadline::standard().unwrap(),
    )
    .unwrap();
    let live = crate::system::app_lookup::revalidate_app_for_mutation(
        &FilteredInventory,
        &resolved,
        Deadline::standard().unwrap(),
    )
    .unwrap();
    assert_eq!(live.process_instance.as_deref(), Some("generation"));
}

struct IncompleteAfterLease(std::sync::atomic::AtomicUsize);

impl ObservationOps for IncompleteAfterLease {
    fn query_app_inventory(
        &self,
        _query: AppInventoryQuery<'_>,
        _deadline: Deadline,
    ) -> Result<AppInventory, AdapterError> {
        let calls = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(AppInventory {
            apps: vec![app()],
            skipped: if calls == 0 {
                Vec::new()
            } else {
                vec![serde_json::json!({"field":"identity"})]
            },
        })
    }
}
impl ActionOps for IncompleteAfterLease {}
impl InputOps for IncompleteAfterLease {}
impl SystemOps for IncompleteAfterLease {
    crate::adapter::guarded_interaction_lease!();

    fn close_app(
        &self,
        _app: &AppInfo,
        _force: bool,
        _lease: &crate::InteractionLease,
    ) -> Result<crate::OperationReport, AdapterError> {
        panic!("incomplete post-lease inventory must not authorize mutation")
    }
}

#[test]
fn incomplete_post_lease_inventory_refuses_close_before_delivery() {
    let error = crate::commands::close_app::execute(
        crate::commands::close_app::CloseAppArgs {
            app: "Example".into(),
            force: false,
        },
        &IncompleteAfterLease(std::sync::atomic::AtomicUsize::new(0)),
    )
    .unwrap_err();
    assert_eq!(error.code(), "APP_UNRESPONSIVE");
}
#[test]
fn adapters_can_share_the_display_name_query_contract() {
    use crate::AppInventoryQuery;
    let query = AppInventoryQuery::NameOrAlias("\u{2067}ÉDITOR\u{2069}   app");
    assert!(query.matches_display_name("My Éditor\nApp Helper"));
    assert!(!query.matches_display_name("Éditor Different App"));
    assert!(
        !AppInventoryQuery::Exact {
            name: "editor",
            bundle_id: None
        }
        .matches_display_name("editor-helper")
    );
}
