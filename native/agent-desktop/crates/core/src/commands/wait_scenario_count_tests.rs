use super::*;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::{AdapterError, ErrorCode, WindowInfo, adapter::WindowFilter};

fn ready_button(name: &str) -> crate::AccessibilityNode {
    crate::adapter::minimal_accessibility_node("button", name)
}

fn truncated_container(child_count: u32) -> crate::AccessibilityNode {
    let mut node = crate::adapter::minimal_accessibility_node("group", "list");
    node.children_count = Some(child_count);
    node.subtree_truncated = true;
    node
}

fn doc_window(children: Vec<crate::AccessibilityNode>) -> crate::AccessibilityNode {
    let mut node = crate::adapter::minimal_accessibility_node("window", "Doc");
    node.children = children;
    node
}

fn test_app_window() -> WindowInfo {
    WindowInfo {
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
    }
}

fn test_app_windows() -> Result<Vec<WindowInfo>, AdapterError> {
    Ok(vec![test_app_window()])
}

fn text_wait_args(text: &str, count: Option<usize>, timeout_ms: u64) -> WaitArgs {
    use super::test_support::wait_args;
    WaitArgs {
        mode: WaitModeArgs {
            text: Some(text.into()),
            ..wait_args().mode
        },
        predicate: WaitPredicateArgs {
            count,
            ..wait_args().predicate
        },
        timeout_ms,
        app: Some("TestApp".into()),
    }
}

fn expect_timeout(result: Result<Value, AppError>) -> crate::AdapterError {
    let AppError::Adapter(adapter_err) = result.unwrap_err() else {
        panic!("expected adapter error")
    };
    assert_eq!(adapter_err.code, ErrorCode::Timeout, "expected TIMEOUT");
    adapter_err
}

macro_rules! text_tree_adapter {
    ($name:ident, $tree:expr) => {
        struct $name;

        impl ObservationOps for $name {
            fn observe_tree(
                &self,
                root: crate::locator::live_locator::ObservationRoot<'_>,
                _request: &crate::locator::live_locator::ObservationRequest,
            ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
                crate::adapter::observed_tree(&root, $tree)
            }

            fn list_windows(
                &self,
                _filter: &WindowFilter,
                _deadline: crate::Deadline,
            ) -> Result<Vec<WindowInfo>, AdapterError> {
                test_app_windows()
            }
        }

        impl ActionOps for $name {}

        impl InputOps for $name {}

        impl SystemOps for $name {}
    };
}

text_tree_adapter!(
    IncompleteTextTreeAdapter,
    doc_window(vec![ready_button("ready one"), truncated_container(2)])
);
text_tree_adapter!(
    AllHiddenIncompleteAdapter,
    doc_window(vec![truncated_container(2)])
);
text_tree_adapter!(
    CompleteTextTreeAdapter,
    doc_window(vec![
        ready_button("ready one"),
        ready_button("ready two"),
        ready_button("ready three"),
    ])
);

#[test]
fn text_wait_with_count_on_incomplete_observation_times_out() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let adapter_err = expect_timeout(execute(
        text_wait_args("ready", Some(1), 600),
        &IncompleteTextTreeAdapter,
        &CommandContext::default(),
    ));

    let details = adapter_err.details.expect("timeout carries details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["expected_count"], 1);
}

#[test]
fn text_wait_with_count_zero_on_incomplete_observation_times_out() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let adapter_err = expect_timeout(execute(
        text_wait_args("ready", Some(0), 600),
        &AllHiddenIncompleteAdapter,
        &CommandContext::default(),
    ));

    let details = adapter_err.details.expect("timeout carries details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["expected_count"], 0);
}

#[test]
fn text_wait_without_count_on_incomplete_observation_matches_visible() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let value = execute(
        text_wait_args("ready", None, 1_000),
        &IncompleteTextTreeAdapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["found"], true);
    assert_eq!(value["role"], "button");
    assert!(
        value.get("count").is_none(),
        "at-least-one waits must not report a count"
    );
}

#[test]
fn text_wait_without_count_on_all_hidden_incomplete_observation_times_out() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let adapter_err = expect_timeout(execute(
        text_wait_args("ready", None, 600),
        &AllHiddenIncompleteAdapter,
        &CommandContext::default(),
    ));

    let details = adapter_err.details.expect("timeout carries details");
    assert_eq!(details["kind"], "wait_timeout");
    assert!(details["expected_count"].is_null());
}

#[test]
fn text_wait_with_count_on_complete_observation_matches_exact_count() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let value = execute(
        text_wait_args("ready", Some(3), 1_000),
        &CompleteTextTreeAdapter,
        &CommandContext::default(),
    )
    .unwrap();

    assert_eq!(value["found"], true);
    assert_eq!(value["count"], 3);
}

#[test]
fn text_wait_with_count_on_complete_observation_times_out_when_count_differs() {
    let _guard = crate::refs::refs_test_support::HomeGuard::new();

    let adapter_err = expect_timeout(execute(
        text_wait_args("ready", Some(1), 600),
        &CompleteTextTreeAdapter,
        &CommandContext::default(),
    ));

    let details = adapter_err.details.expect("timeout carries details");
    assert_eq!(details["kind"], "wait_timeout");
    assert_eq!(details["expected_count"], 1);
}
