use agent_desktop_core::{
    ActionResult, AdapterError, AdapterSession, AppInfo, Deadline, DismissAllNotificationsRequest,
    DismissNotificationRequest, DisplayInfo, ImageBuffer, InteractionLease, InteractionPolicy,
    KeyCombo, NotificationActionRequest, NotificationFilter, NotificationInfo, ObservationOps,
    OperationReport, PermissionReport, ProcessIdentity, ScreenshotTarget, SessionAffinity,
    SignalBaseline, SignalFilter, SnapshotSurface, SystemOps, WindowFilter, WindowInfo, WindowOp,
    system::launch_options::LaunchOptions, system::process_state::ProcessState,
};

use crate::adapter::WindowsAdapter;
use crate::system::close_outcome::CloseOutcome;

#[cfg(target_os = "windows")]
#[path = "tcp_listener.rs"]
pub(crate) mod tcp_listener;

impl SystemOps for WindowsAdapter {
    fn update_cursor_overlay(
        &self,
        control: &agent_desktop_core::CursorOverlayControl,
    ) -> Result<(), AdapterError> {
        crate::system::cursor_overlay::spawn::update(control)
    }

    fn run_cursor_overlay_child(&self) -> Option<Result<(), AdapterError>> {
        crate::system::cursor_overlay::child::entry_from_env()
    }

    /// The cross-process desktop-interaction lease: an exclusive,
    /// token-derived lock file when `AGENT_DESKTOP_INTERACTION_LEASE_HANDLE`
    /// is unset, or adoption of the inherited handle it names - re-verifying
    /// both the handle's identity and its exclusivity before trusting it,
    /// because a handle's share mode cannot be read back on Windows and
    /// identity alone proves naming rather than exclusion - when it is set.
    /// Mirrors `MacOSAdapter`'s two-branch override over
    /// `acquire_unix_interaction_lease` / `adopt_inherited_unix_interaction_lease`.
    #[cfg(target_os = "windows")]
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        match std::env::var(crate::system::interaction_lease::INTERACTION_LEASE_HANDLE_ENV) {
            Ok(value) => {
                let raw = value.parse::<isize>().map_err(|_| {
                    AdapterError::new(
                        agent_desktop_core::ErrorCode::InvalidArgs,
                        "Inherited interaction lease handle must be a valid integer",
                    )
                })?;
                crate::system::interaction_lease::adopt_inherited(raw, deadline)
            }
            Err(_) => crate::system::interaction_lease::acquire(deadline),
        }
    }

    /// No cross-process lock exists off Windows in this crate; the
    /// in-process guard core's activation loop needs is still supplied so a
    /// non-Windows build of this crate (compiled by CI on every platform,
    /// never shipped) does not fail closed on the first settle.
    #[cfg(not(target_os = "windows"))]
    fn acquire_interaction_lease(
        &self,
        deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        InteractionLease::guarded(deadline, ())
    }

    /// The Chromium settle: connecting to UI Automation already triggered the
    /// renderer's asynchronous accessibility build (A1-4/A1-5), so activation
    /// is the connection-plus-settle itself. A short backoff lets the build
    /// start landing before core's loop re-walks; core's own retry backoff is
    /// what turns this into a real wait, and the adapter notes that the
    /// settle ran **for this process** so a same-process retry keeps only the
    /// walk in the loop, never a second activation, while an unrelated
    /// process observed through the same adapter still gets its own pass.
    fn activate_renderer_accessibility(
        &self,
        process: ProcessIdentity,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        self.note_renderer_activation_attempted(process);
        let settled = lease.deadline().remaining();
        if settled.is_zero() {
            return Ok(());
        }
        std::thread::sleep(settled.min(std::time::Duration::from_millis(50)));
        Ok(())
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

    fn unknown_accessibility_means_unsupported(&self) -> bool {
        true
    }

    /// The surfaces this adapter can observe: a named window, the focused
    /// window, a Chromium modal-as-sheet, an open application menu, and the
    /// shell kinds the shell-surface resolver reaches on this build. Core
    /// validates the requested surface against this list before the adapter
    /// is ever called (the mirror of macOS `supported_surfaces`), so a kind
    /// advertised here always has a matching `surface_root` arm - advertising
    /// without an arm would convert the old emit/advertise asymmetry into an
    /// advertise/resolve one. `quick-settings` is deliberately absent: this
    /// build carries the quick actions inside the Action Center, so the kind
    /// refuses in core with the standard shape instead of pretending it can
    /// root.
    fn supported_surfaces(&self) -> Vec<SnapshotSurface> {
        vec![
            SnapshotSurface::Window,
            SnapshotSurface::Focused,
            SnapshotSurface::Sheet,
            SnapshotSurface::Menu,
            SnapshotSurface::StartMenu,
            SnapshotSurface::Taskbar,
            SnapshotSurface::SystemTray,
            SnapshotSurface::SystemTrayOverflow,
            SnapshotSurface::ActionCenter,
        ]
    }

    /// The raise half of the shell-surface seam, beside the resolve half the
    /// observation adapter carries: the kind table in `system::shell_surface`
    /// owns both the reach mechanics and the focus-steal floor, so this is
    /// the translation that hands it the caller's policy and the lease's
    /// budget. A caller whose policy forbids the foreground to move, and a
    /// build that lacks the requested kind, are both refused there before
    /// anything is raised; the lease itself is what excludes other desktop
    /// interactions for the raise's duration.
    fn open_system_surface(
        &self,
        surface: SnapshotSurface,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<WindowInfo, AdapterError> {
        crate::system::shell::shell_surface_open::open_surface(surface, policy, lease.deadline())
    }

    /// The focused window is the focused-only filter's first result, composed
    /// from `list_windows` rather than a second native path (mirroring
    /// `focused_window` in `crates/macos/src/system/adapter.rs`). Whatever HWND-shape a
    /// host presents, it maps to the same identity `list_windows` reports.
    fn focused_window(&self, deadline: Deadline) -> Result<Option<WindowInfo>, AdapterError> {
        let filter = WindowFilter {
            focused_only: true,
            app: None,
        };
        let windows = self.list_windows(&filter, deadline)?;
        Ok(windows.into_iter().next())
    }

    /// Process liveness for the shared `ProcessState` contract. Returns the
    /// raw classification only — core's two-signal gate owns any upgrade to
    /// `APP_UNRESPONSIVE` (A21-3, A21-4).
    fn process_state(
        &self,
        process: ProcessIdentity,
        deadline: Deadline,
    ) -> Result<ProcessState, AdapterError> {
        crate::system::process_state::process_state_impl(process, deadline)
    }

    /// Session- and shell-critical image names; exact match, case-insensitive.
    fn is_protected_process(&self, identifier: &str) -> bool {
        crate::system::app_ops::is_protected_process(identifier)
    }

    /// `CreateProcessW` launch with system-directory-only bare-name resolution
    /// and ToolHelp attach detection (A21-1, A21-8).
    fn launch_app(
        &self,
        id: &str,
        options: &LaunchOptions,
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

    /// Verified termination: `Ok(())` only after the process is observed gone
    /// (A21-3). Graceful posts `WM_CLOSE`; force calls `TerminateProcess`.
    fn close_app(
        &self,
        app: &AppInfo,
        force: bool,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let dispatched = crate::system::close::close_app_impl(app, force, lease.deadline())
            .map(|outcome| outcome == CloseOutcome::Exited);
        OperationReport::from_close_dispatch(app, dispatched)
    }

    /// `SetWindowPos`/`ShowWindow` with Win32 placement re-read verification
    /// (A21-5); never UIA `IsOffscreen`/`-32000`.
    fn window_op(
        &self,
        win: &WindowInfo,
        op: WindowOp,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let readback = crate::system::window::window_op_readback::window_readback(&op);
        let dispatched =
            crate::system::window::window_op::window_op_impl(win, op.clone(), lease.deadline());
        OperationReport::from_window_dispatch(win, &op, readback, dispatched)
    }

    fn resolve_window_strict(
        &self,
        win: &WindowInfo,
        deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        crate::system::window::window_resolve::resolve_window_strict(win, deadline)
    }

    fn focus_window(&self, win: &WindowInfo, lease: &InteractionLease) -> Result<(), AdapterError> {
        crate::system::window::window_activate::focus_window(win, lease)
    }

    fn list_displays(&self, deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        crate::system::display::list_displays_live(deadline)
    }

    #[cfg(target_os = "windows")]
    fn screenshot(
        &self,
        target: ScreenshotTarget,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        crate::system::capture::screenshot::screenshot(target, deadline)
    }

    #[cfg(target_os = "windows")]
    fn screenshot_window_frame(
        &self,
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        crate::system::capture::screenshot::capture_window(window, deadline)
    }

    /// Verify-only composition over the keyboard primitive. Core's headed
    /// path already activated; this never raises (A9-3: SendInput has no
    /// per-pid targeting).
    fn press_key_for_app(
        &self,
        process: ProcessIdentity,
        combo: &KeyCombo,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        crate::system::key_dispatch::press_for_app_impl(process, combo, policy, lease.deadline())
    }

    /// The core default blocks nothing; Windows ships its own dangerous-combo
    /// list so the skill-documented guard actually enforces on this
    /// platform. `--force` is honored entirely in core.
    fn is_blocked_combo(&self, combo: &KeyCombo) -> bool {
        crate::input::blocked_combo::is_blocked(combo)
    }

    fn open_session(
        &self,
        _affinity: &SessionAffinity,
        deadline: Deadline,
    ) -> Result<Box<dyn AdapterSession>, AdapterError> {
        Ok(Box::new(crate::system::runtime::session::open(deadline)?))
    }

    /// The other half of `wait`'s menu surface: a bounded poll over the
    /// two-source menu predicate, structured as a port of the macOS poll
    /// loop.
    fn wait_for_menu(
        &self,
        process: ProcessIdentity,
        open: bool,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        crate::system::wait::wait_for_menu(process, open, deadline)
    }

    /// The other half of `wait`'s baseline surface: the single-pass
    /// windows+apps inventory composed with the app-scoped surface scan
    /// under one shared deadline, with `completeness` derived from whether
    /// each pass ran to completion.
    fn capture_signal_baseline(
        &self,
        filter: &SignalFilter,
        deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        crate::system::signal::signals::capture_signal_baseline_impl(filter, deadline)
    }

    /// Listing carries the same lease-consistency check the macOS adapter
    /// runs - a headed observation must hold the cross-process lease - and
    /// then delegates. The focus-steal floor itself is the notifications
    /// module's: it refuses only when the closed center would have to be
    /// raised, so an already-present center stays listable headlessly, which
    /// is the same conditional shape macOS's own listing floor has.
    fn list_notifications(
        &self,
        filter: &NotificationFilter,
        policy: InteractionPolicy,
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

    /// Every mutation receives the caller's policy beside the lease's
    /// deadline, so the module's foreground floor answers before the session
    /// raises anything. The identity travels as-is and is verified against a
    /// fresh read inside the module, never against the index alone.
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

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
