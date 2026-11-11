use agent_desktop_core::{
    ActionResult, AdapterError, Deadline, DismissAllNotificationsRequest,
    DismissNotificationRequest, ImageBuffer, InteractionLease, NotificationActionRequest,
    NotificationFilter, NotificationInfo, OperationReport, PermissionReport, ProcessIdentity,
    ScreenshotTarget, SignalBaseline, SignalFilter, SnapshotSurface, SystemOps, WindowInfo,
    WindowOp,
};

use crate::adapter::MacOSAdapter;
use crate::system::app::close_outcome::CloseOutcome;

#[cfg(target_os = "macos")]
#[path = "tcp_listener/mod.rs"]
pub(crate) mod tcp_listener;

impl SystemOps for MacOSAdapter {
    fn update_cursor_overlay(
        &self,
        control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        crate::system::cursor_overlay::update(control)
    }

    fn run_cursor_overlay_child(&self) -> Option<Result<(), AdapterError>> {
        crate::system::cursor_overlay::entry_from_env()
    }

    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        let Some(raw) = std::env::var_os(agent_desktop_core::INTERACTION_LEASE_FD_ENV) else {
            return agent_desktop_core::acquire_unix_interaction_lease(deadline);
        };
        let raw = raw.into_string().map_err(|_| {
            AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Inherited interaction lease FD must be valid UTF-8",
            )
        })?;
        let fd = raw.parse::<std::os::fd::RawFd>().map_err(|_| {
            AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Inherited interaction lease FD must be a nonnegative integer",
            )
        })?;
        if fd < 0 {
            return Err(AdapterError::new(
                agent_desktop_core::ErrorCode::InvalidArgs,
                "Inherited interaction lease FD must be a nonnegative integer",
            ));
        }
        agent_desktop_core::adopt_inherited_unix_interaction_lease(fd, deadline)
    }

    fn permission_report(&self, deadline: Deadline) -> Result<PermissionReport, AdapterError> {
        crate::system::permissions::report(deadline)
    }

    fn request_permissions(
        &self,
        lease: &InteractionLease,
    ) -> Result<PermissionReport, AdapterError> {
        crate::system::permissions::request_report(lease.deadline())
    }

    fn start_permission_guide(&self) -> Result<&'static str, AdapterError> {
        crate::system::permissions::permission_guide::start()
    }

    fn unknown_accessibility_means_unsupported(&self) -> bool {
        false
    }

    fn activate_renderer_accessibility(
        &self,
        process: ProcessIdentity,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::system::renderer_activation::activate(process, lease.deadline())
    }

    fn focus_window(&self, win: &WindowInfo, lease: &InteractionLease) -> Result<(), AdapterError> {
        crate::system::focus::focus_window_impl(win, lease.deadline())
    }

    fn launch_app(
        &self,
        id: &str,
        options: &agent_desktop_core::system::launch_options::LaunchOptions,
        lease: &InteractionLease,
    ) -> Result<agent_desktop_core::system::launch_result::LaunchResult, AdapterError> {
        crate::system::launch::launch_app_impl(id, options, lease.deadline())
    }

    fn process_owns_tcp_listener(
        &self,
        process: ProcessIdentity,
        port: u16,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        tcp_listener::owns_listener(&process, port, deadline)
    }

    fn process_state(
        &self,
        process: ProcessIdentity,
        deadline: Deadline,
    ) -> Result<agent_desktop_core::system::process_state::ProcessState, AdapterError> {
        crate::system::process::process_state::process_state_impl(process, deadline)
    }

    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        crate::system::signals::supported_surfaces_impl()
    }

    fn capture_signal_baseline(
        &self,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        crate::system::signals::capture_signal_baseline_impl(
            filter,
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn close_app(
        &self,
        app: &agent_desktop_core::AppInfo,
        force: bool,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let dispatched = crate::system::app::app_ops::close_app_impl(app, force, lease.deadline())
            .map(|outcome| outcome == CloseOutcome::Exited);
        OperationReport::from_close_dispatch(app, dispatched)
    }

    fn is_protected_process(&self, identifier: &str) -> bool {
        crate::system::app::app_ops::is_protected_process(identifier)
    }

    fn is_blocked_combo(&self, combo: &agent_desktop_core::KeyCombo) -> bool {
        crate::input::blocked_combo::is_blocked(combo)
    }

    fn list_displays(
        &self,
        deadline: Deadline,
    ) -> Result<Vec<agent_desktop_core::DisplayInfo>, AdapterError> {
        crate::system::display::list_displays_impl(deadline)
    }

    fn screenshot(
        &self,
        target: ScreenshotTarget,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        match target {
            ScreenshotTarget::Screen(idx) => {
                crate::system::screenshot::capture_screen(idx, deadline)
            }
            ScreenshotTarget::Display { index, expected } => {
                crate::system::screenshot::capture_display(index, &expected, deadline)
            }
            ScreenshotTarget::ExactWindow(window) => {
                crate::system::screenshot::capture_window(&window, deadline)
            }
            ScreenshotTarget::FullScreen => crate::system::screenshot::capture_screen(0, deadline),
        }
    }

    fn screenshot_window_frame(
        &self,
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        crate::system::screenshot::capture_window_frame(window, deadline)
    }

    fn focused_window(&self, deadline: Deadline) -> Result<Option<WindowInfo>, AdapterError> {
        crate::system::window::window_inventory::focused_window_until(
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn press_key_for_app(
        &self,
        process: ProcessIdentity,
        combo: &agent_desktop_core::KeyCombo,
        policy: agent_desktop_core::InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        crate::system::key_dispatch::press_for_app_impl(process, combo, policy, lease.deadline())
    }

    fn wait_for_menu(
        &self,
        process: ProcessIdentity,
        open: bool,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        crate::system::wait::wait_for_menu(process, open, deadline)
    }

    fn resolve_window_strict(
        &self,
        win: &WindowInfo,
        deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        crate::system::window::window_resolve::resolve_window_strict(
            win,
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn window_op(
        &self,
        win: &WindowInfo,
        op: WindowOp,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let readback = crate::system::window::window_report::window_readback(&op);
        let dispatched =
            crate::system::window::window_ops::execute(win, op.clone(), lease.deadline());
        OperationReport::from_window_dispatch(win, &op, readback, dispatched)
    }

    fn list_notifications(
        &self,
        filter: &NotificationFilter,
        policy: agent_desktop_core::InteractionPolicy,
        deadline: Deadline,
        lease: Option<&InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        if policy.allow_focus_steal && lease.is_none() {
            return Err(AdapterError::internal(
                "Headed notification observation requires an interaction lease",
            ));
        }
        crate::notifications::list::list_notifications(filter, policy, deadline)
    }

    fn dismiss_notification(
        &self,
        request: DismissNotificationRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<NotificationInfo, AdapterError> {
        crate::notifications::actions::dismiss_notification(
            request.index,
            request.app_filter,
            Some(request.identity),
            request.policy,
            _lease.deadline(),
        )
    }

    fn dismiss_all_notifications(
        &self,
        request: DismissAllNotificationsRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
        crate::notifications::actions::dismiss_all(
            request.app_filter,
            request.policy,
            _lease.deadline(),
        )
    }

    fn notification_action(
        &self,
        request: NotificationActionRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        crate::notifications::actions::notification_action(
            request.index,
            Some(request.identity),
            request.action_name,
            request.policy,
            _lease.deadline(),
        )
    }
}
