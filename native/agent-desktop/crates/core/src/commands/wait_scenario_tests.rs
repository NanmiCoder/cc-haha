use super::test_support::wait_args;
use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, ErrorCode, WindowInfo, adapter::WindowFilter};

struct TextlessTreeAdapter;

impl ObservationOps for TextlessTreeAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        crate::adapter::observed_tree(
            &root,
            crate::AccessibilityNode {
                ref_id: None,
                role: "window".into(),
                identity: crate::NodeIdentity {
                    retained_object: None,
                    name: Some("Doc".into()),
                    ..Default::default()
                },
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            },
        )
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![WindowInfo {
            id: "w-1".into(),
            title: "Doc".into(),
            app: "TestApp".into(),
            pid: crate::ProcessId::new(1),
            process_instance: Some("test-instance".into()),
            bounds: None,
            state: crate::WindowState {
                is_focused: true,
                ..Default::default()
            },
        }])
    }

    fn get_tree(
        &self,
        _win: &WindowInfo,
        _opts: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<crate::AccessibilityNode, AdapterError> {
        Ok(crate::AccessibilityNode {
            ref_id: None,
            role: "window".into(),
            identity: crate::NodeIdentity {
                retained_object: None,
                name: Some("Doc".into()),
                ..Default::default()
            },
            presentation: Default::default(),
            children_count: None,
            subtree_truncated: false,
            children: vec![],
        })
    }
}

impl ActionOps for TextlessTreeAdapter {}

impl InputOps for TextlessTreeAdapter {}

impl SystemOps for TextlessTreeAdapter {}

struct WindowWaitAdapter(Vec<WindowInfo>);

impl ObservationOps for WindowWaitAdapter {
    fn list_windows(
        &self,
        filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(self
            .0
            .iter()
            .filter(|window| filter.app.as_ref().is_none_or(|app| &window.app == app))
            .cloned()
            .collect())
    }
}

impl ActionOps for WindowWaitAdapter {}
impl InputOps for WindowWaitAdapter {}
impl SystemOps for WindowWaitAdapter {}

#[test]
fn ambiguous_text_wait_suggests_window_wait_and_snapshot_recovery() {
    let mut first = TextlessTreeAdapter
        .list_windows(
            &WindowFilter::default(),
            crate::Deadline::standard().unwrap(),
        )
        .unwrap()
        .remove(0);
    first.state.is_focused = false;
    let mut second = first.clone();
    second.id = "w-2".into();
    second.title = "Keyboard Shortcuts".into();
    let error = execute(
        WaitArgs {
            mode: WaitModeArgs {
                text: Some("Search Shortcuts".into()),
                ..wait_args().mode
            },
            timeout_ms: 5_000,
            app: Some("TestApp".into()),
            ..wait_args()
        },
        &WindowWaitAdapter(vec![first, second]),
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "AMBIGUOUS_TARGET");
    match error {
        AppError::Adapter(adapter_error) => {
            let suggestion = adapter_error.suggestion.unwrap();
            assert!(suggestion.contains("wait --window"), "{suggestion}");
            assert!(suggestion.contains("snapshot --window-id"), "{suggestion}");
            assert!(!suggestion.contains("wait --window-id"), "{suggestion}");
        }
        _ => panic!("expected adapter error"),
    }
}

#[test]
fn window_wait_scopes_matches_and_missing_window_diagnostics_to_the_app() {
    let mut project = TextlessTreeAdapter
        .list_windows(
            &WindowFilter::default(),
            crate::Deadline::standard().unwrap(),
        )
        .unwrap()
        .remove(0);
    project.app = "GarageBand".into();
    project.title = "Project".into();
    let mut unrelated = project.clone();
    unrelated.app = "OtherApp".into();
    unrelated.title = "Musical Typing".into();
    let adapter = WindowWaitAdapter(vec![project, unrelated]);
    let mut args = WaitArgs {
        mode: WaitModeArgs {
            window: Some("Musical Typing".into()),
            ..wait_args().mode
        },
        timeout_ms: 20,
        ..wait_args()
    };
    let result = execute(args.clone(), &adapter, &CommandContext::default()).unwrap();
    assert_eq!(result["window"]["app_name"], "OtherApp");

    args.app = Some("GarageBand".into());
    let error = execute(args.clone(), &adapter, &CommandContext::default()).unwrap_err();
    let AppError::Adapter(error) = error else {
        panic!("adapter error expected")
    };
    assert_eq!(error.code, ErrorCode::Timeout);
    let details = error.details.unwrap();
    assert_eq!(details["title"], "Musical Typing");
    assert_eq!(details["app"], "GarageBand");
    assert_eq!(details["last_observed"]["count"], 1);
    assert_eq!(details["last_observed"]["titles"], json!(["Project"]));

    args.mode.window = Some("Pro".into());
    let result = execute(args, &adapter, &CommandContext::default()).unwrap();
    assert_eq!(result["window"]["app_name"], "GarageBand");
}

#[test]
fn missing_window_diagnostics_bound_count_and_unicode_title_length() {
    let mut windows = TextlessTreeAdapter
        .list_windows(
            &WindowFilter::default(),
            crate::Deadline::standard().unwrap(),
        )
        .unwrap();
    windows[0].title = "é".repeat(150);
    let observed = wait_timeout::window_observation(&vec![windows[0].clone(); 10]);
    assert_eq!(observed["count"], 10);
    assert_eq!(observed["titles"].as_array().unwrap().len(), 8);
    assert_eq!(observed["titles"][0].as_str().unwrap().chars().count(), 120);
    assert_eq!(observed["truncated"], true);
}

#[test]
fn text_wait_with_count_zero_detects_absence() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let value = execute(
        WaitArgs {
            mode: WaitModeArgs {
                text: Some("Gone".into()),
                ..wait_args().mode
            },
            predicate: WaitPredicateArgs {
                count: Some(0),
                ..wait_args().predicate
            },
            timeout_ms: 1_000,
            app: Some("TestApp".into()),
        },
        &TextlessTreeAdapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["found"], true);
    assert_eq!(value["count"], 0);
}

struct LoadingPanel(std::sync::atomic::AtomicUsize);

impl ObservationOps for LoadingPanel {
    fn list_windows(
        &self,
        filter: &WindowFilter,
        deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            return Err(AdapterError::new(
                ErrorCode::WindowNotFound,
                "The panel is replacing its window",
            ));
        }
        TextlessTreeAdapter.list_windows(filter, deadline)
    }

    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        TextlessTreeAdapter.observe_tree(root, request)
    }
}

impl ActionOps for LoadingPanel {}
impl InputOps for LoadingPanel {}
impl SystemOps for LoadingPanel {}

#[test]
fn text_wait_survives_a_temporarily_missing_panel_window() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();
    let adapter = LoadingPanel(std::sync::atomic::AtomicUsize::new(0));
    let result = execute(
        WaitArgs {
            mode: WaitModeArgs {
                text: Some("Doc".into()),
                ..wait_args().mode
            },
            timeout_ms: 5_000,
            app: Some("TestApp".into()),
            ..wait_args()
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(result["found"], true);
    assert!(adapter.0.load(std::sync::atomic::Ordering::SeqCst) >= 2);
}
