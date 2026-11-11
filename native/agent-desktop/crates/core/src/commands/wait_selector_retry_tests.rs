use super::*;

struct MaterializeTimeoutAdapter {
    observations: AtomicUsize,
}

impl ObservationOps for MaterializeTimeoutAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        if self.observations.fetch_add(1, Ordering::SeqCst) > 0 {
            return Err(AdapterError::timeout("final snapshot timed out"));
        }
        crate::adapter::observed_tree(&root, window_node(vec![button_node("saved")]))
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        StaticTreeAdapter {
            tree: window_node(Vec::new()),
        }
        .list_windows(_filter, _deadline)
    }

    fn get_tree(
        &self,
        _win: &WindowInfo,
        _opts: &crate::adapter::TreeOptions,
        _deadline: crate::Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Err(AdapterError::timeout("final snapshot timed out"))
    }
}

impl ActionOps for MaterializeTimeoutAdapter {}
impl InputOps for MaterializeTimeoutAdapter {}
impl SystemOps for MaterializeTimeoutAdapter {}

struct MaterializeMissAdapter {
    observations: AtomicUsize,
}

impl ObservationOps for MaterializeMissAdapter {
    fn observe_tree(
        &self,
        root: crate::locator::live_locator::ObservationRoot<'_>,
        _request: &crate::locator::live_locator::ObservationRequest,
    ) -> Result<crate::locator::live_locator::ObservedTree, AdapterError> {
        let tree = match self.observations.fetch_add(1, Ordering::SeqCst) {
            0 => window_node(vec![button_node("saved")]),
            1 => window_node(vec![button_node("newest")]),
            _ => return Err(AdapterError::timeout("poll timed out")),
        };
        crate::adapter::observed_tree(&root, tree)
    }

    fn list_windows(
        &self,
        filter: &WindowFilter,
        deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        StaticTreeAdapter {
            tree: window_node(Vec::new()),
        }
        .list_windows(filter, deadline)
    }
}

impl ActionOps for MaterializeMissAdapter {}
impl InputOps for MaterializeMissAdapter {}
impl SystemOps for MaterializeMissAdapter {}

#[test]
fn materialization_timeout_uses_the_wait_timeout_envelope() {
    let _guard = HomeGuard::new();
    let error = execute(
        WaitSelectorInput {
            timeout_ms: 30,
            ..base_input("button:saved", false)
        },
        &MaterializeTimeoutAdapter {
            observations: AtomicUsize::new(0),
        },
        &CommandContext::default(),
    )
    .unwrap_err();

    let AppError::Adapter(error) = error else {
        panic!("expected adapter timeout");
    };
    assert_eq!(error.details.unwrap()["kind"], "wait_timeout");
}

#[test]
fn appearance_window_not_found_swallowed_until_timeout() {
    let _guard = HomeGuard::new();
    let err = execute(
        WaitSelectorInput {
            timeout_ms: 50,
            ..base_input("button:saved", false)
        },
        &CodeErrorAdapter {
            code: ErrorCode::WindowNotFound,
        },
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "TIMEOUT");
}

#[test]
fn appearance_element_not_found_without_retry_evidence_fails_fast() {
    let _guard = HomeGuard::new();
    let err = execute(
        WaitSelectorInput {
            timeout_ms: 50,
            ..base_input("button:saved", false)
        },
        &CodeErrorAdapter {
            code: ErrorCode::ElementNotFound,
        },
        &CommandContext::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "ELEMENT_NOT_FOUND");
}

#[test]
fn incomplete_locator_timeout_is_polled_until_wait_deadline() {
    let _guard = HomeGuard::new();
    let started = std::time::Instant::now();
    let err = execute(
        WaitSelectorInput {
            timeout_ms: 50,
            ..base_input("button:saved", false)
        },
        &CodeErrorAdapter {
            code: ErrorCode::Timeout,
        },
        &CommandContext::default(),
    )
    .unwrap_err();

    assert_eq!(err.code(), "TIMEOUT");
    assert!(started.elapsed() >= std::time::Duration::from_millis(40));
    let AppError::Adapter(error) = err else {
        panic!("expected adapter error");
    };
    assert_eq!(error.details.unwrap()["kind"], "wait_timeout");
}

#[test]
fn persisted_snapshot_is_loadable() {
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
    let snapshot_id = value["snapshot_id"].as_str().unwrap();
    let store = RefStore::new().unwrap();
    let refmap = store.load(Some(snapshot_id)).unwrap();
    assert!(!refmap.is_empty());
}

#[test]
fn zero_timeout_persists_a_diagnostic_snapshot() {
    let _guard = HomeGuard::new();
    let error = execute(
        WaitSelectorInput {
            timeout_ms: 0,
            ..base_input(":missing", false)
        },
        &StaticTreeAdapter {
            tree: window_node(vec![button_node("other")]),
        },
        &CommandContext::default(),
    )
    .expect_err("missing selector must time out");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter timeout");
    };
    let snapshot_id = error.details.expect("timeout details")["snapshot_id"]
        .as_str()
        .expect("diagnostic snapshot id")
        .to_owned();
    assert!(RefStore::new().unwrap().load(Some(&snapshot_id)).is_ok());
}

#[test]
fn materialization_miss_retains_its_fresh_snapshot_for_timeout() {
    let _guard = HomeGuard::new();
    let error = execute(
        WaitSelectorInput {
            timeout_ms: 30,
            ..base_input("button:saved", false)
        },
        &MaterializeMissAdapter {
            observations: AtomicUsize::new(0),
        },
        &CommandContext::default(),
    )
    .expect_err("materialization miss must resume waiting");

    let AppError::Adapter(error) = error else {
        panic!("expected adapter timeout");
    };
    let snapshot_id = error.details.expect("timeout details")["snapshot_id"]
        .as_str()
        .expect("diagnostic snapshot id")
        .to_owned();
    let refmap = RefStore::new().unwrap().load(Some(&snapshot_id)).unwrap();
    assert_eq!(
        refmap
            .get("@e1")
            .and_then(|entry| entry.identity.name.as_deref()),
        Some("newest")
    );
}
