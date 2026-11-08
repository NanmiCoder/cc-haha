use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{
    AccessibilityNode, AdapterError, ErrorCode, WindowInfo, adapter::WindowFilter,
    context::CommandContext, refs::refs_store::RefStore, refs::refs_test_support::HomeGuard,
};
use std::sync::atomic::{AtomicUsize, Ordering};

fn window_node(children: Vec<AccessibilityNode>) -> AccessibilityNode {
    AccessibilityNode {
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
        children,
    }
}

fn button_node(label: &str) -> AccessibilityNode {
    AccessibilityNode {
        ref_id: None,
        role: "button".into(),
        identity: crate::NodeIdentity {
            retained_object: None,
            name: Some(label.into()),
            ..Default::default()
        },
        presentation: Default::default(),
        children_count: None,
        subtree_truncated: false,
        children: vec![],
    }
}

struct StaticTreeAdapter {
    tree: AccessibilityNode,
}

impl ObservationOps for StaticTreeAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        crate::adapter::observed_tree(&root, self.tree.clone())
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
    ) -> Result<AccessibilityNode, AdapterError> {
        Ok(self.tree.clone())
    }
}

impl ActionOps for StaticTreeAdapter {}

impl InputOps for StaticTreeAdapter {}

impl SystemOps for StaticTreeAdapter {}

struct FlippingTreeAdapter {
    calls: AtomicUsize,
    before: AccessibilityNode,
    after: AccessibilityNode,
}

impl ObservationOps for FlippingTreeAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let tree = if call == 0 {
            self.before.clone()
        } else {
            self.after.clone()
        };
        crate::adapter::observed_tree(&root, tree)
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
    ) -> Result<AccessibilityNode, AdapterError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            Ok(self.before.clone())
        } else {
            Ok(self.after.clone())
        }
    }
}

impl ActionOps for FlippingTreeAdapter {}

impl InputOps for FlippingTreeAdapter {}

impl SystemOps for FlippingTreeAdapter {}

struct ErrorThenTreeAdapter;

impl ObservationOps for ErrorThenTreeAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(AdapterError::new(ErrorCode::AppNotFound, "app missing"))
    }
}

impl ActionOps for ErrorThenTreeAdapter {}

impl InputOps for ErrorThenTreeAdapter {}

impl SystemOps for ErrorThenTreeAdapter {}

struct CodeErrorAdapter {
    code: ErrorCode,
}

impl ObservationOps for CodeErrorAdapter {
    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(AdapterError::new(self.code.clone(), "poll error"))
    }
}

impl ActionOps for CodeErrorAdapter {}

impl InputOps for CodeErrorAdapter {}

impl SystemOps for CodeErrorAdapter {}

fn base_input(query_raw: &str, gone: bool) -> WaitSelectorInput {
    WaitSelectorInput {
        query_raw: query_raw.into(),
        gone,
        app: Some("TestApp".into()),
        window_id: None,
        opts: crate::adapter::TreeOptions::default(),
        timeout_ms: 500,
    }
}

#[test]
fn match_everything_selector_rejected() {
    let _guard = HomeGuard::new();
    let err = execute(
        WaitSelectorInput {
            query_raw: String::new(),
            gone: false,
            app: None,
            window_id: None,
            opts: crate::adapter::TreeOptions::default(),
            timeout_ms: 500,
        },
        &StaticTreeAdapter {
            tree: window_node(vec![]),
        },
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "INVALID_ARGS");
}

#[test]
fn present_on_first_poll_returns_snapshot_envelope() {
    let _guard = HomeGuard::new();
    let adapter = StaticTreeAdapter {
        tree: window_node(vec![button_node("saved")]),
    };
    let value = execute(
        base_input("button:saved", false),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(value["matched_selector"], "button:saved");
    assert!(value["elapsed_ms"].as_u64().is_some());
    assert!(value["snapshot_id"].as_str().is_some());
    assert_eq!(value["ref_count"].as_u64(), Some(1));
}

#[test]
fn absent_then_present_on_second_poll() {
    let _guard = HomeGuard::new();
    let adapter = FlippingTreeAdapter {
        calls: AtomicUsize::new(0),
        before: window_node(vec![]),
        after: window_node(vec![button_node("saved")]),
    };
    let value = execute(
        base_input("button:saved", false),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(value["matched_selector"], "button:saved");
    assert!(adapter.calls.load(Ordering::SeqCst) >= 2);
}

#[test]
fn gone_true_returns_when_element_disappears() {
    let _guard = HomeGuard::new();
    let adapter = FlippingTreeAdapter {
        calls: AtomicUsize::new(0),
        before: window_node(vec![button_node("spinner")]),
        after: window_node(vec![]),
    };
    let value = execute(
        base_input("button:spinner", true),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(value["matched_selector"], "button:spinner");
    assert!(adapter.calls.load(Ordering::SeqCst) >= 2);
}

#[test]
fn gone_true_when_never_present_returns_immediately() {
    let _guard = HomeGuard::new();
    let adapter = StaticTreeAdapter {
        tree: window_node(vec![]),
    };
    let value = execute(
        base_input(":missing", true),
        &adapter,
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(value["matched_selector"], ":missing");
}

#[test]
fn timeout_persists_the_last_diagnostic_snapshot() {
    let _guard = HomeGuard::new();
    let adapter = StaticTreeAdapter {
        tree: window_node(vec![button_node("other")]),
    };
    let err = execute(
        WaitSelectorInput {
            timeout_ms: 50,
            ..base_input(":missing", false)
        },
        &adapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "TIMEOUT");
    let details = match err {
        AppError::Adapter(adapter_err) => adapter_err.details.expect("timeout details"),
        other => panic!("expected adapter timeout, got {other:?}"),
    };
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["predicate"], "selector");
    let snapshot_id = details["snapshot_id"]
        .as_str()
        .expect("diagnostic snapshot id");
    assert!(RefStore::new().unwrap().load(Some(snapshot_id)).is_ok());
    assert!(
        details.get("last_error").is_none(),
        "last_error must be omitted when no poll error occurred, got {details}"
    );
}

#[path = "wait_selector_inherited_deadline_tests.rs"]
mod inherited_deadline_tests;

#[test]
fn retryable_app_not_found_swallowed_until_timeout() {
    let _guard = HomeGuard::new();
    let err = execute(
        WaitSelectorInput {
            timeout_ms: 50,
            ..base_input("button:saved", false)
        },
        &ErrorThenTreeAdapter,
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "TIMEOUT");
    let details = match err {
        AppError::Adapter(adapter_err) => adapter_err.details.expect("timeout details"),
        other => panic!("expected adapter timeout, got {other:?}"),
    };
    assert_eq!(details["last_error"]["code"], "APP_NOT_FOUND");
}

#[test]
fn gone_true_with_app_not_found_returns_immediately() {
    let _guard = HomeGuard::new();
    let value = execute(
        WaitSelectorInput {
            timeout_ms: 30_000,
            ..base_input("button:spinner", true)
        },
        &ErrorThenTreeAdapter,
        &CommandContext::default(),
    )
    .expect("app gone satisfies a wait-for-gone");
    assert_eq!(value["gone"], true);
    assert_eq!(value["target_absent"], true);
    assert_eq!(value["matched_selector"], "button:spinner");
}

#[test]
fn gone_true_with_window_not_found_returns_immediately() {
    let _guard = HomeGuard::new();
    let value = execute(
        WaitSelectorInput {
            timeout_ms: 30_000,
            ..base_input("button:spinner", true)
        },
        &CodeErrorAdapter {
            code: ErrorCode::WindowNotFound,
        },
        &CommandContext::default(),
    )
    .expect("window gone satisfies a wait-for-gone");
    assert_eq!(value["target_absent"], true);
}

#[path = "wait_selector_retry_tests.rs"]
mod retry_tests;
