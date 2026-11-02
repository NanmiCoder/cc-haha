use super::dispatch;
use crate::cli::Commands;
use crate::cli_args::actions::PressArgs;
use crate::cli_args::system::ClipboardSetArgs;
use crate::dispatch::test_support::{HomeGuard, started_overlay_session};

use agent_desktop_core::{
    ActionOps, ActionRequest, ActionResult, AdapterError, ClipboardContent, CursorOverlayControl,
    Deadline, InputOps, InteractionLease, KeyCombo, NativeHandle, ObservationOps, PermissionReport,
    SystemOps, context::CommandContext,
};
use std::sync::Mutex;

struct RecordingOverlayAdapter {
    controls: Mutex<Vec<CursorOverlayControl>>,
}

impl RecordingOverlayAdapter {
    fn new() -> Self {
        Self {
            controls: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for RecordingOverlayAdapter {}

impl ActionOps for RecordingOverlayAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("PressKey"))
    }
}

impl InputOps for RecordingOverlayAdapter {
    fn set_clipboard_content(
        &self,
        _content: &ClipboardContent,
        _lease: &InteractionLease,
    ) -> Result<agent_desktop_core::OperationReport, AdapterError> {
        Ok(agent_desktop_core::OperationReport::delivered_unverified(
            "test",
            agent_desktop_core::OperationTarget::Clipboard,
        ))
    }

    fn clear_clipboard(
        &self,
        _lease: &InteractionLease,
    ) -> Result<agent_desktop_core::OperationReport, AdapterError> {
        Ok(agent_desktop_core::OperationReport::delivered_unverified(
            "test",
            agent_desktop_core::OperationTarget::Clipboard,
        ))
    }
}

impl SystemOps for RecordingOverlayAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.controls.lock().unwrap().push(control.clone());
        Ok(())
    }
}

struct BlockingComboAdapter {
    controls: Mutex<Vec<CursorOverlayControl>>,
}

impl BlockingComboAdapter {
    fn new() -> Self {
        Self {
            controls: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for BlockingComboAdapter {}
impl ActionOps for BlockingComboAdapter {}
impl InputOps for BlockingComboAdapter {}

impl SystemOps for BlockingComboAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn is_blocked_combo(&self, _combo: &KeyCombo) -> bool {
        true
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.controls.lock().unwrap().push(control.clone());
        Ok(())
    }
}

struct FailingOverlayAdapter {
    controls: Mutex<Vec<CursorOverlayControl>>,
}

impl FailingOverlayAdapter {
    fn new() -> Self {
        Self {
            controls: Mutex::new(Vec::new()),
        }
    }
}

impl ObservationOps for FailingOverlayAdapter {}

impl ActionOps for FailingOverlayAdapter {
    fn execute_action(
        &self,
        _handle: &NativeHandle,
        _request: ActionRequest,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Ok(ActionResult::delivered_unverified("PressKey"))
    }
}

impl InputOps for FailingOverlayAdapter {
    fn clear_clipboard(
        &self,
        _lease: &InteractionLease,
    ) -> Result<agent_desktop_core::OperationReport, AdapterError> {
        Ok(agent_desktop_core::OperationReport::delivered_unverified(
            "test",
            agent_desktop_core::OperationTarget::Clipboard,
        ))
    }
}

impl SystemOps for FailingOverlayAdapter {
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    fn update_cursor_overlay(&self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        self.controls.lock().unwrap().push(control.clone());
        Err(AdapterError::internal("renderer unavailable"))
    }
}

fn headed_context(manifest: &agent_desktop_core::session::SessionManifest) -> CommandContext {
    CommandContext::new(Some(manifest.id.clone()), None, false)
        .unwrap()
        .with_headed(true)
}

#[test]
fn mutating_keyboard_and_clipboard_commands_re_show_cursor_overlay() {
    let _home = HomeGuard::new();
    let manifest = started_overlay_session();
    let context = headed_context(&manifest);
    let adapter = RecordingOverlayAdapter::new();

    dispatch(
        Commands::Press(PressArgs {
            combo: "a".into(),
            app: None,
            window_id: None,
            force: false,
        }),
        &adapter,
        &PermissionReport::default(),
        &context,
    )
    .unwrap();
    dispatch(
        Commands::ClipboardSet(ClipboardSetArgs {
            text: Some("agent".into()),
            image: None,
            file_url: vec![],
        }),
        &adapter,
        &PermissionReport::default(),
        &context,
    )
    .unwrap();
    dispatch(
        Commands::ClipboardClear,
        &adapter,
        &PermissionReport::default(),
        &context,
    )
    .unwrap();

    let recorded = adapter.controls.lock().unwrap();
    assert_eq!(
        recorded.len(),
        6,
        "each mutating command must bracket with a Hide+Show pair"
    );
    for (index, control) in recorded.iter().enumerate() {
        if index % 2 == 0 {
            assert!(
                matches!(control, CursorOverlayControl::Hide { .. }),
                "control #{index} should be Hide, got {control:?}"
            );
        } else {
            assert!(
                matches!(control, CursorOverlayControl::Show { .. }),
                "control #{index} should be Show, got {control:?}"
            );
        }
        assert_eq!(
            control.session_id(),
            manifest.id.as_str(),
            "control #{index} must target the active session"
        );
    }
}

#[test]
fn non_mutating_commands_skip_cursor_overlay_lifecycle() {
    let _home = HomeGuard::new();
    let manifest = started_overlay_session();
    let context = headed_context(&manifest);
    let adapter = RecordingOverlayAdapter::new();

    dispatch(
        Commands::Version,
        &adapter,
        &PermissionReport::default(),
        &context,
    )
    .unwrap();

    assert!(
        adapter.controls.lock().unwrap().is_empty(),
        "non-mutating commands must not emit overlay controls"
    );
}

#[test]
fn cursor_overlay_show_fires_even_when_the_mutating_command_errors() {
    let _home = HomeGuard::new();
    let manifest = started_overlay_session();
    let context = headed_context(&manifest);
    let adapter = BlockingComboAdapter::new();

    let result = dispatch(
        Commands::Press(PressArgs {
            combo: "cmd+q".into(),
            app: None,
            window_id: None,
            force: false,
        }),
        &adapter,
        &PermissionReport::default(),
        &context,
    );

    let error = result.expect_err("the blocked combo must still be rejected by the press command");
    assert_eq!(error.code(), "POLICY_DENIED");

    let recorded = adapter.controls.lock().unwrap();
    assert_eq!(
        recorded.len(),
        2,
        "the Hide+Show bracket must complete even when the command errors"
    );
    assert!(
        matches!(recorded[0], CursorOverlayControl::Hide { .. }),
        "Hide must be emitted before the command runs"
    );
    assert!(
        matches!(recorded[1], CursorOverlayControl::Show { .. }),
        "Show must re-show the overlay even after a failed command"
    );
    for control in recorded.iter() {
        assert_eq!(control.session_id(), manifest.id.as_str());
    }
}

#[test]
fn failing_overlay_control_does_not_abort_the_mutating_command() {
    let _home = HomeGuard::new();
    let manifest = started_overlay_session();
    let context = headed_context(&manifest);
    let adapter = FailingOverlayAdapter::new();

    let result = dispatch(
        Commands::ClipboardClear,
        &adapter,
        &PermissionReport::default(),
        &context,
    );

    assert!(
        result.is_ok(),
        "the mutating command must succeed even when the overlay renderer errors"
    );

    let recorded = adapter.controls.lock().unwrap();
    assert_eq!(
        recorded.len(),
        2,
        "the Hide+Show bracket must still be attempted when the renderer errors"
    );
    assert!(matches!(recorded[0], CursorOverlayControl::Hide { .. }));
    assert!(matches!(recorded[1], CursorOverlayControl::Show { .. }));
}
