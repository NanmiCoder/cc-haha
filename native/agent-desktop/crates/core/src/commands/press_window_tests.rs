use super::{PressArgs, execute};
use crate::actions::action_request::ActionRequest;
use crate::actions::action_result::ActionResult;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::context::CommandContext;
use crate::{AdapterError, KeyCombo};
use std::sync::Mutex;

#[derive(Default)]
struct TwoInstancesAdapter {
    pressed_pid: Mutex<Option<u32>>,
    focused_window: Mutex<Option<String>>,
    active: Mutex<Option<crate::WindowInfo>>,
    active_read_error: Mutex<Option<AdapterError>>,
}

fn instance(pid: u32) -> crate::AppInfo {
    crate::AppInfo {
        name: "Electron".into(),
        pid: crate::ProcessId::new(pid),
        bundle_id: Some("com.github.Electron".into()),
        process_instance: Some(format!("generation-{pid}")),
        presentation: None,
    }
}

fn window(pid: u32) -> crate::WindowInfo {
    crate::WindowInfo {
        id: format!("w-{pid}"),
        title: format!("Instance {pid}"),
        app: "Electron".into(),
        pid: crate::ProcessId::new(pid),
        process_instance: Some(format!("generation-{pid}")),
        bounds: None,
        state: crate::WindowState {
            visible: Some(true),
            ..Default::default()
        },
    }
}

impl ObservationOps for TwoInstancesAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![instance(41), instance(42)])
    }

    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        let mut second = window(42);
        second.id = "w-42-prefs".into();
        second.title = "Preferences".into();
        Ok(vec![window(41), window(42), second])
    }
}

impl ActionOps for TwoInstancesAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        panic!("a targeted press must never fall back to global delivery")
    }
}

impl InputOps for TwoInstancesAdapter {}

impl SystemOps for TwoInstancesAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        *self.focused_window.lock().unwrap() = Some(window.id.clone());
        Ok(())
    }

    fn focused_window(
        &self,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::WindowInfo>, AdapterError> {
        if let Some(error) = self.active_read_error.lock().unwrap().take() {
            return Err(error);
        }
        Ok(self.active.lock().unwrap().clone())
    }

    fn press_key_for_app(
        &self,
        process: crate::ProcessIdentity,
        _combo: &KeyCombo,
        _policy: crate::InteractionPolicy,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        *self.pressed_pid.lock().unwrap() = Some(process.pid.get());
        Ok(ActionResult::delivered_unverified("PressKey"))
    }
}

fn press(
    app: Option<&str>,
    window_id: Option<&str>,
    adapter: &TwoInstancesAdapter,
) -> Result<serde_json::Value, crate::AppError> {
    press_with(app, window_id, adapter, &CommandContext::default())
}

fn press_with(
    app: Option<&str>,
    window_id: Option<&str>,
    adapter: &TwoInstancesAdapter,
    context: &CommandContext,
) -> Result<serde_json::Value, crate::AppError> {
    execute(
        PressArgs {
            combo: "cmd+k".into(),
            app: app.map(str::to_owned),
            window_id: window_id.map(str::to_owned),
            force: false,
        },
        adapter,
        context,
    )
}

#[test]
fn window_id_reaches_the_instance_that_owns_the_window() {
    let adapter = with_active("w-42", 42);

    press(None, Some("w-42"), &adapter).unwrap();

    assert_eq!(*adapter.pressed_pid.lock().unwrap(), Some(42));
}

#[test]
fn window_id_narrows_an_app_name_shared_by_two_instances() {
    let adapter = with_active("w-41", 41);

    press(Some("Electron"), Some("w-41"), &adapter).unwrap();

    assert_eq!(*adapter.pressed_pid.lock().unwrap(), Some(41));
}

#[test]
fn app_name_alone_stays_ambiguous_across_instances() {
    let adapter = TwoInstancesAdapter::default();

    let error = press(Some("Electron"), None, &adapter).unwrap_err();

    assert_eq!(error.code(), "AMBIGUOUS_TARGET");
    assert!(adapter.pressed_pid.lock().unwrap().is_none());
}

#[test]
fn unknown_window_id_is_window_not_found() {
    let adapter = TwoInstancesAdapter::default();

    let error = press(None, Some("w-7"), &adapter).unwrap_err();

    assert_eq!(error.code(), "WINDOW_NOT_FOUND");
    assert!(adapter.pressed_pid.lock().unwrap().is_none());
}

#[test]
fn headed_window_id_focuses_the_named_window_not_another_of_the_instance() {
    let adapter = TwoInstancesAdapter::default();
    let context = CommandContext::default().with_headed(true);

    press_with(None, Some("w-42-prefs"), &adapter, &context).unwrap();

    assert_eq!(
        adapter.focused_window.lock().unwrap().as_deref(),
        Some("w-42-prefs")
    );
    assert_eq!(*adapter.pressed_pid.lock().unwrap(), Some(42));
}

fn with_active(id: &str, pid: u32) -> TwoInstancesAdapter {
    let adapter = TwoInstancesAdapter::default();
    let mut active = window(pid);
    active.id = id.into();
    *adapter.active.lock().unwrap() = Some(active);
    adapter
}

#[test]
fn the_named_window_that_is_the_active_one_is_pressed() {
    let adapter = with_active("w-42-prefs", 42);

    press(None, Some("w-42-prefs"), &adapter).unwrap();

    assert_eq!(*adapter.pressed_pid.lock().unwrap(), Some(42));
}

#[test]
fn another_window_of_the_process_is_refused_headless_and_nothing_is_pressed() {
    let adapter = with_active("w-42", 42);

    let error = press(None, Some("w-42-prefs"), &adapter).unwrap_err();

    assert_eq!(error.code(), "STALE_REF");
    let crate::AppError::Adapter(error) = error else {
        panic!("an adapter error")
    };
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(
        error.details.as_ref().unwrap()["cause"],
        "exact_window_focus_unconfirmed"
    );
    assert!(error.suggestion.as_deref().unwrap().contains("--headed"));
    assert!(adapter.pressed_pid.lock().unwrap().is_none());
    assert!(adapter.focused_window.lock().unwrap().is_none());
}

#[test]
fn exact_window_refusal_respects_the_actual_interaction_mode() {
    for policy in [
        crate::InteractionPolicy::headless(),
        crate::InteractionPolicy::focus_fallback(),
        crate::InteractionPolicy::headed(),
    ] {
        let adapter = with_active("w-42", 42);
        let deadline = crate::Deadline::standard().unwrap();
        let lease = crate::InteractionLease::guarded(deadline, ()).unwrap();
        let error = adapter
            .press_key_for_window(
                &window(41),
                &KeyCombo {
                    key: "a".into(),
                    modifiers: Vec::new(),
                },
                policy,
                &lease,
            )
            .unwrap_err();
        assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
        let hint = error.suggestion.unwrap();
        assert_eq!(hint.contains("--headed"), !policy.is_headed(), "{hint}");
        assert!(adapter.pressed_pid.lock().unwrap().is_none());
    }
}

#[test]
fn headed_brings_the_named_window_forward_instead_of_refusing() {
    let adapter = with_active("w-42", 42);
    let context = CommandContext::default().with_headed(true);

    press_with(None, Some("w-42-prefs"), &adapter, &context).unwrap();

    assert_eq!(
        adapter.focused_window.lock().unwrap().as_deref(),
        Some("w-42-prefs")
    );
    assert_eq!(*adapter.pressed_pid.lock().unwrap(), Some(42));
}

#[test]
fn a_focused_window_of_another_process_is_refused_without_delivery() {
    let adapter = with_active("w-41", 41);

    let error = press(None, Some("w-42"), &adapter).unwrap_err();

    assert_eq!(error.code(), "STALE_REF");
    assert!(adapter.pressed_pid.lock().unwrap().is_none());
}

#[test]
fn failed_focus_read_preserves_diagnostics_without_delivery() {
    for code in [crate::ErrorCode::Timeout, crate::ErrorCode::PermDenied] {
        let adapter = with_active("w-42", 42);
        *adapter.active_read_error.lock().unwrap() = Some(
            AdapterError::new(code.clone(), "Exact focus read failed")
                .with_suggestion("Restore access to the focused window")
                .with_platform_detail("native focus lookup failed")
                .with_details(serde_json::json!({ "check": "native_focus_read" })),
        );

        let error = press(None, Some("w-42-prefs"), &adapter).unwrap_err();

        let crate::AppError::Adapter(error) = error else {
            panic!("an adapter error")
        };
        assert_eq!(error.code, code);
        assert_eq!(error.message, "Exact focus read failed");
        assert_eq!(
            error.suggestion.as_deref(),
            Some("Restore access to the focused window")
        );
        assert_eq!(
            error.platform_detail.as_deref(),
            Some("native focus lookup failed")
        );
        assert_eq!(
            error.details.unwrap(),
            serde_json::json!({ "check": "native_focus_read" })
        );
        assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
        assert!(adapter.pressed_pid.lock().unwrap().is_none());
        assert!(adapter.focused_window.lock().unwrap().is_none());
    }
}

#[test]
fn missing_focused_window_refuses_without_delivery() {
    let adapter = TwoInstancesAdapter::default();

    let error = press(None, Some("w-42-prefs"), &adapter).unwrap_err();

    assert_eq!(error.code(), "STALE_REF");
    assert!(adapter.pressed_pid.lock().unwrap().is_none());
}

#[test]
fn matching_window_id_with_a_different_or_unknown_owner_refuses_without_delivery() {
    for (pid, instance) in [
        (41, Some("generation-42")),
        (42, Some("recycled")),
        (42, None),
    ] {
        let adapter = with_active("w-42-prefs", pid);
        adapter
            .active
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .process_instance = instance.map(str::to_owned);

        let error = press(None, Some("w-42-prefs"), &adapter).unwrap_err();

        assert_eq!(error.code(), "STALE_REF");
        assert!(adapter.pressed_pid.lock().unwrap().is_none());
    }
}
