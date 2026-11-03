use agent_desktop_core::system::launch_options::LaunchOptions;
use agent_desktop_core::system::launch_result::LaunchResult;
use agent_desktop_core::system::process_state::ProcessState;
use agent_desktop_core::{
    ActionResult, AdapterError, AdapterSession, AppInfo, Deadline, DismissAllNotificationsRequest,
    DismissNotificationRequest, DisplayInfo, ErrorCode, ImageBuffer, InteractionLease,
    InteractionPolicy, KeyCombo, NotificationActionRequest, NotificationFilter, NotificationInfo,
    OperationReport, PermissionReport, ProcessIdentity, ScreenshotTarget, SessionAffinity,
    SignalBaseline, SignalFilter, SnapshotSurface, SystemOps, WindowInfo, WindowOp,
};

use crate::adapter::LinuxAdapter;
use crate::notifications;
use crate::system::{
    close,
    focus::key_dispatch,
    interaction::{action_clock, interaction_lease, session},
    launch,
    menu::{menu_surface, menu_wait},
    permissions,
    process::process_state,
    shell,
    signal::signal_capture,
    window::window_op,
};

const SURFACE_PROBE_MS: u64 = 3_000;

impl SystemOps for LinuxAdapter {
    fn subscribe_wait(
        &self,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Result<Option<Box<dyn agent_desktop_core::WaitWakeup>>, AdapterError> {
        Ok(Some(Box::new(
            super::signal::subscription::Subscription::open(self.bus(), filter, deadline)?,
        )))
    }

    fn update_cursor_overlay(
        &self,
        control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        crate::system::overlay::cursor_overlay::update(control)
    }

    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        interaction_lease::acquire(deadline)
    }

    fn permission_report(&self, deadline: Deadline) -> Result<PermissionReport, AdapterError> {
        permissions::report(self.bus(), deadline)
    }

    fn focused_window(&self, deadline: Deadline) -> Result<Option<WindowInfo>, AdapterError> {
        crate::system::focused_window(self.bus(), deadline)
    }

    fn resolve_window_strict(
        &self,
        win: &WindowInfo,
        deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        crate::system::resolve_window_strict(self.bus(), win, deadline)
    }

    fn list_displays(&self, deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        crate::system::list_displays(deadline)
    }

    fn focus_window(&self, win: &WindowInfo, lease: &InteractionLease) -> Result<(), AdapterError> {
        crate::system::focus::focus_window::focus_window(self.bus(), win, lease)
    }

    fn close_app(
        &self,
        app: &AppInfo,
        force: bool,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        close::close_app(self.bus(), app, force, lease)
    }

    fn launch_app(
        &self,
        id: &str,
        options: &LaunchOptions,
        lease: &InteractionLease,
    ) -> Result<LaunchResult, AdapterError> {
        launch::launch_app(self.bus(), id, options, lease)
    }

    fn process_owns_tcp_listener(
        &self,
        process: ProcessIdentity,
        port: u16,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        crate::system::process::tcp_listener::owns_listener(&process, port, deadline)
    }

    fn process_state(
        &self,
        process: ProcessIdentity,
        deadline: Deadline,
    ) -> Result<ProcessState, AdapterError> {
        process_state::process_state(self.bus(), process, deadline)
    }

    fn window_op(
        &self,
        win: &WindowInfo,
        op: WindowOp,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        window_op::window_op(self.bus(), win, op, lease)
    }

    fn press_key_for_app(
        &self,
        process: ProcessIdentity,
        combo: &KeyCombo,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let pid = process.pid.get();
        let result = key_dispatch::press_key_for_app(self.bus(), process, combo, policy, lease);
        action_clock::mark_outcome(Some(pid), &result);
        result
    }

    fn press_key_for_window(
        &self,
        window: &WindowInfo,
        combo: &KeyCombo,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let result = key_dispatch::press_key_for_window(self.bus(), window, combo, policy, lease);
        action_clock::mark_outcome(Some(window.pid.get()), &result);
        result
    }

    fn is_blocked_combo(&self, combo: &KeyCombo) -> bool {
        crate::input::blocked_combo::is_blocked(combo)
    }

    fn screenshot(
        &self,
        target: ScreenshotTarget,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        crate::system::capture::screenshot::screenshot(self.bus(), target, deadline)
    }

    fn screenshot_window_frame(
        &self,
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        crate::system::capture::screenshot::screenshot_window_frame(self.bus(), window, deadline)
    }

    fn capture_signal_baseline(
        &self,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        signal_capture::capture_signal_baseline(self.bus(), filter, deadline)
    }

    fn wait_for_menu(
        &self,
        process: ProcessIdentity,
        open: bool,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        menu_wait::wait_for_menu(self.bus(), process, open, deadline)
    }

    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        let Ok(deadline) = Deadline::after(SURFACE_PROBE_MS) else {
            return Vec::new();
        };
        if !permissions::accessibility_answers(self.bus(), deadline) {
            return Vec::new();
        }
        let mut surfaces = vec![
            SnapshotSurface::Window,
            SnapshotSurface::Sheet,
            SnapshotSurface::Alert,
        ];
        surfaces.extend(menu_surface::supported());
        surfaces.extend(shell::supported(self.bus()));
        surfaces
    }

    fn check_surface_support(&self, requested: SnapshotSurface) -> Result<(), AdapterError> {
        if matches!(
            requested,
            SnapshotSurface::Window
                | SnapshotSurface::Sheet
                | SnapshotSurface::Alert
                | SnapshotSurface::Menu
        ) {
            return Ok(());
        }
        let supported = self.supported_surfaces();
        if supported.contains(&requested) {
            return Ok(());
        }
        Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            format!("Snapshot surface '{}' is not supported on this platform", requested.as_str()),
        )
        .with_details(serde_json::json!({
            "requested_surface": requested.as_str(),
            "supported_surfaces": supported.into_iter().map(SnapshotSurface::as_str).collect::<Vec<_>>()
        }))
        .with_suggestion("Choose one of the supported snapshot surfaces"))
    }

    fn open_session(
        &self,
        _affinity: &SessionAffinity,
        deadline: Deadline,
    ) -> Result<Box<dyn AdapterSession>, AdapterError> {
        Ok(Box::new(session::open(self.bus(), deadline)?))
    }

    fn dismiss_all_notifications(
        &self,
        request: DismissAllNotificationsRequest<'_>,
        lease: &InteractionLease,
    ) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
        notifications::dismiss_all(self.bus(), request, lease)
    }

    fn dismiss_notification(
        &self,
        request: DismissNotificationRequest<'_>,
        lease: &InteractionLease,
    ) -> Result<NotificationInfo, AdapterError> {
        notifications::dismiss(self.bus(), request, lease)
    }

    fn check_notification_support(&self, deadline: Deadline) -> Result<(), AdapterError> {
        notifications::check_support(deadline)
    }

    fn list_notifications(
        &self,
        filter: &NotificationFilter,
        policy: InteractionPolicy,
        deadline: Deadline,
        lease: Option<&InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        notifications::list(self.bus(), filter, policy, deadline, lease)
    }

    fn notification_action(
        &self,
        request: NotificationActionRequest<'_>,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        notifications::action(self.bus(), request, lease)
    }

    fn open_system_surface(
        &self,
        surface: SnapshotSurface,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<WindowInfo, AdapterError> {
        shell::open_surface(self.bus(), surface, policy, lease)
    }
}
