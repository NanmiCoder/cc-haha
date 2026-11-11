use crate::{
    ActionOps, AdapterError, AppInfo, CommandContext, Deadline, InputOps, NotificationFilter,
    NotificationInfo, ObservationOps, SignalBaseline, SignalCompleteness, SignalFilter, SystemOps,
    WaitWakeup,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct WakeState {
    registered: bool,
    reads: usize,
    waits: usize,
    dropped: bool,
}

struct WakeAdapter(Arc<Mutex<WakeState>>);
struct Subscription(Arc<Mutex<WakeState>>);

impl WaitWakeup for Subscription {
    fn wait(&mut self, deadline: Deadline) -> Result<(), AdapterError> {
        assert!(deadline.remaining() <= Duration::from_millis(100));
        let mut state = self.0.lock().unwrap();
        state.waits += 1;
        if state.waits == 1 {
            Ok(())
        } else {
            Err(AdapterError::new(
                crate::ErrorCode::Internal,
                "subscription lost",
            ))
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.0.lock().unwrap().dropped = true;
    }
}

impl ObservationOps for WakeAdapter {
    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        Ok(vec![crate::WindowInfo {
            id: "w-42".into(),
            title: "Doc".into(),
            app: "Editor".into(),
            pid: crate::ProcessId::new(42),
            process_instance: Some("generation".into()),
            bounds: None,
            state: crate::WindowState {
                is_focused: true,
                ..Default::default()
            },
        }])
    }

    fn observe_tree(
        &self,
        root: crate::ObservationRoot<'_>,
        _request: &crate::ObservationRequest,
    ) -> Result<crate::ObservedTree, AdapterError> {
        let mut state = self.0.lock().unwrap();
        assert!(state.registered, "subscribe before the initial tree read");
        state.reads += 1;
        let node = crate::adapter::minimal_accessibility_node(
            "button",
            if state.reads >= 2 { "new" } else { "old" },
        );
        crate::adapter::observed_tree(&root, node)
    }
}
impl ActionOps for WakeAdapter {}
impl InputOps for WakeAdapter {}
impl SystemOps for WakeAdapter {
    fn subscribe_wait(
        &self,
        filter: &SignalFilter,
        _deadline: Deadline,
    ) -> Result<Option<Box<dyn WaitWakeup>>, AdapterError> {
        assert!(filter.app.is_none());
        self.0.lock().unwrap().registered = true;
        Ok(Some(Box::new(Subscription(self.0.clone()))))
    }

    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        _deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        let mut state = self.0.lock().unwrap();
        assert!(state.registered, "subscribe before the initial baseline");
        state.reads += 1;
        Ok(SignalBaseline {
            apps: if state.reads >= 4 {
                vec![app()]
            } else {
                Vec::new()
            },
            windows: Vec::new(),
            surfaces: Vec::new(),
            completeness: SignalCompleteness::complete(),
        })
    }

    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        _policy: crate::InteractionPolicy,
        _deadline: Deadline,
        _lease: Option<&crate::InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        let mut state = self.0.lock().unwrap();
        assert!(state.registered, "subscribe before the initial inventory");
        state.reads += 1;
        let mut notifications = vec![notification("old")];
        if state.reads >= 2 {
            notifications.push(notification("new"));
        }
        Ok(notifications)
    }
}

fn app() -> AppInfo {
    AppInfo {
        name: "Editor".into(),
        pid: crate::ProcessId::new(42),
        bundle_id: None,
        process_instance: Some("generation".into()),
        presentation: None,
    }
}

fn notification(id: &str) -> NotificationInfo {
    NotificationInfo {
        index: usize::from(id == "new"),
        app_name: "Editor".into(),
        title: id.into(),
        body: None,
        actions: Vec::new(),
    }
}

#[test]
fn event_wakes_and_disconnects_resample_without_fabricating_events() {
    let state = Arc::new(Mutex::new(WakeState::default()));
    let result = super::wait_event::wait_for_event(
        super::wait_event_input::EventWaitInput {
            event: "app-launched".into(),
            app: None,
            window_id: None,
            window_title: None,
            timeout_ms: 2000,
        },
        &WakeAdapter(state.clone()),
        None,
    )
    .unwrap();
    assert_eq!(result["event"]["app"], "Editor");
    let state = state.lock().unwrap();
    assert_eq!(state.reads, 4);
    assert_eq!(state.waits, 2);
    assert!(state.dropped);
}

#[test]
fn notification_subscription_precedes_baseline_and_only_new_inventory_matches() {
    let state = Arc::new(Mutex::new(WakeState::default()));
    let result = super::wait_notification::wait_for_notification(
        None,
        None,
        2000,
        &WakeAdapter(state.clone()),
        &CommandContext::default(),
    )
    .unwrap();
    assert_eq!(result["notification"]["title"], "new");
    let state = state.lock().unwrap();
    assert_eq!(state.reads, 2);
    assert_eq!(state.waits, 1);
    assert!(state.dropped);
}

#[test]
fn text_and_selector_subscribe_before_reading_and_resample_after_wakes() {
    let _home = crate::refs::refs_test_support::HomeGuard::new();
    for selector in [false, true] {
        let state = Arc::new(Mutex::new(WakeState::default()));
        let adapter = WakeAdapter(state.clone());
        let context = CommandContext::default();
        let result = if selector {
            super::wait_selector::execute(
                super::wait_selector::WaitSelectorInput {
                    query_raw: "button:new".into(),
                    gone: false,
                    app: None,
                    window_id: None,
                    opts: crate::TreeOptions::default(),
                    timeout_ms: 2000,
                },
                &adapter,
                &context,
            )
        } else {
            super::wait::execute(
                super::wait::WaitArgs {
                    mode: super::wait::WaitModeArgs {
                        text: Some("new".into()),
                        ..Default::default()
                    },
                    predicate: super::wait::WaitPredicateArgs {
                        predicate: None,
                        value: None,
                        action: None,
                        count: None,
                    },
                    timeout_ms: 2000,
                    app: None,
                },
                &adapter,
                &context,
            )
        }
        .unwrap();
        assert!(result["snapshot_id"].is_string());
        let state = state.lock().unwrap();
        assert_eq!(state.reads, if selector { 3 } else { 2 });
        assert_eq!(state.waits, 1);
        assert!(state.dropped);
    }
}
