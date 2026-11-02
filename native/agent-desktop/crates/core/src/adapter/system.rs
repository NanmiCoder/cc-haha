use crate::{
    AdapterError, AdapterSession, AppInfo, CursorOverlayControl, Deadline,
    DismissAllNotificationsRequest, DismissNotificationRequest, ImageBuffer, InteractionLease,
    InteractionPolicy, KeyCombo, NotificationActionRequest, NotificationFilter, NotificationInfo,
    OperationReport, PermissionReport, PermissionState, ProcessIdentity, SessionAffinity,
    SignalBaseline, SignalFilter, WindowInfo, WindowOp, actions::action_result::ActionResult,
    system::display_info::DisplayInfo, system::screenshot_target::ScreenshotTarget,
};

pub trait SystemOps: Send + Sync {
    fn update_cursor_overlay(&self, _control: &CursorOverlayControl) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("update_cursor_overlay"))
    }

    fn run_cursor_overlay_child(&self) -> Option<Result<(), AdapterError>> {
        None
    }

    fn acquire_interaction_lease(
        &self,
        _deadline: Deadline,
    ) -> Result<InteractionLease, AdapterError> {
        Err(AdapterError::not_supported("acquire_interaction_lease"))
    }

    /// An adapter that never overrides this has not probed permissions at all,
    /// which is not the same fact as a user denying one. `Unknown` routes through
    /// `unknown_accessibility_means_unsupported` to `PLATFORM_NOT_SUPPORTED`
    /// rather than the misleading `PERM_DENIED`.
    fn permission_report(&self, _deadline: Deadline) -> Result<PermissionReport, AdapterError> {
        Ok(PermissionReport {
            accessibility: PermissionState::Unknown,
            screen_recording: PermissionState::Unknown,
            automation: PermissionState::NotRequired,
        })
    }

    fn unknown_accessibility_means_unsupported(&self) -> bool {
        true
    }

    /// Performs one renderer-accessibility activation mutation and returns.
    /// Readiness polling belongs to core after the interaction lease is dropped.
    fn activate_renderer_accessibility(
        &self,
        _process: ProcessIdentity,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported(
            "activate_renderer_accessibility",
        ))
    }

    fn request_permissions(
        &self,
        lease: &InteractionLease,
    ) -> Result<PermissionReport, AdapterError> {
        self.permission_report(lease.deadline())
    }

    /// Starts a detached, on-screen guide that walks the user through granting
    /// the missing permissions, and returns without waiting for it. The result
    /// is `started`, `already_running`, or `not_needed`.
    fn start_permission_guide(&self) -> Result<&'static str, AdapterError> {
        Err(AdapterError::not_supported("start_permission_guide"))
    }

    /// Performs the platform-native focus/raise operation for the exact window.
    /// Core decides when focus is required; implementations must return only
    /// after that window is confirmed focused, or return an error.
    fn focus_window(
        &self,
        _win: &WindowInfo,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("focus_window"))
    }

    fn launch_app(
        &self,
        _id: &str,
        _options: &crate::system::launch_options::LaunchOptions,
        _lease: &InteractionLease,
    ) -> Result<crate::system::launch_result::LaunchResult, AdapterError> {
        Err(AdapterError::not_supported("launch_app"))
    }

    fn process_owns_tcp_listener(
        &self,
        _process: crate::ProcessIdentity,
        _port: u16,
        _deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        Err(AdapterError::not_supported("process_owns_tcp_listener"))
    }

    fn process_state(
        &self,
        _process: ProcessIdentity,
        _deadline: Deadline,
    ) -> Result<crate::system::process_state::ProcessState, AdapterError> {
        Err(AdapterError::not_supported("process_state"))
    }

    fn supported_surfaces(&self) -> Vec<crate::adapter::SnapshotSurface> {
        Vec::new()
    }

    fn check_surface_support(&self, requested: crate::SnapshotSurface) -> Result<(), AdapterError> {
        let supported = self.supported_surfaces();
        if supported.contains(&requested) {
            return Ok(());
        }
        Err(AdapterError::new(
            crate::ErrorCode::PlatformNotSupported,
            format!("Snapshot surface '{}' is not supported on this platform", requested.as_str()),
        )
        .with_details(serde_json::json!({
            "requested_surface": requested.as_str(),
            "supported_surfaces": supported.into_iter().map(crate::SnapshotSurface::as_str).collect::<Vec<_>>()
        }))
        .with_suggestion("Choose one of the supported snapshot surfaces"))
    }

    /// Registers caller-scoped wake hints before the initial predicate read.
    /// Without a subscription the same predicates run with bounded polling.
    fn subscribe_wait(
        &self,
        _filter: &SignalFilter,
        _deadline: Deadline,
    ) -> Result<Option<Box<dyn crate::WaitWakeup>>, AdapterError> {
        Ok(None)
    }

    /// Raises an OS-chrome surface - the Start menu, the Action Center, the
    /// taskbar - and returns the identity of the window the surface actually
    /// presents, in the same shape the window observation stack consumes. It
    /// takes the lease because it mutates OS chrome and takes the foreground;
    /// the policy travels separately because the lease carries no
    /// focus-steal refusal. Implementations must refuse with `POLICY_DENIED`
    /// before anything is raised when `policy.allow_focus_steal` is false,
    /// must return an already-present surface without raising it again, and
    /// must answer a kind their platform does not expose with a refusal that
    /// names what a caller should ask for instead - never with this default.
    fn open_system_surface(
        &self,
        _surface: crate::adapter::SnapshotSurface,
        _policy: InteractionPolicy,
        _lease: &InteractionLease,
    ) -> Result<WindowInfo, AdapterError> {
        Err(AdapterError::not_supported("open_system_surface"))
    }

    /// Opens adapter-native connection affinity for a persistent host.
    ///
    /// The returned session may retain platform connection state, but never a
    /// resolved element handle. Stateless command callers do not need to open a
    /// session. Adapters without persistent native state return
    /// `PLATFORM_NOT_SUPPORTED`.
    fn open_session(
        &self,
        _affinity: &SessionAffinity,
        _deadline: Deadline,
    ) -> Result<Box<dyn AdapterSession>, AdapterError> {
        Err(AdapterError::not_supported("open_session"))
    }

    /// Captures a point-in-time [`SignalBaseline`] snapshot,
    /// narrowed by `filter` when the caller already knows which app it cares
    /// about. `deadline` is one absolute budget shared by every native read in
    /// the capture; an adapter must return `TIMEOUT` rather than publish an
    /// observation completed at or after it. `wait --event` calls this once at
    /// wait-start and again on every poll, then diffs the two snapshots with
    /// `crate::diff_signals` — the adapter never decides what changed,
    /// only what the desktop looks like right now.
    fn capture_signal_baseline(
        &self,
        _filter: &SignalFilter,
        _deadline: Deadline,
    ) -> Result<SignalBaseline, AdapterError> {
        Err(AdapterError::not_supported("capture_signal_baseline"))
    }

    fn close_app(
        &self,
        _app: &AppInfo,
        _force: bool,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("close_app"))
    }

    /// Reports whether closing `identifier` would terminate a process the OS
    /// depends on (window server, login session, shell). The set is
    /// inherently platform-specific, so each adapter owns its own list;
    /// core only asks. The default denies nothing.
    fn is_protected_process(&self, _identifier: &str) -> bool {
        false
    }

    /// Reports whether `combo` is a platform-dangerous keyboard shortcut that
    /// should be refused unless the caller explicitly forces it (for example
    /// macOS Cmd+Q quit, Ctrl+Cmd+Q lock, Cmd+Alt+Esc force-quit). Which
    /// combos are dangerous — and how key names alias to physical keys — is
    /// platform-specific, so each adapter owns its own list; core only asks
    /// and lets the caller override via `--force`. The default blocks nothing,
    /// leaving the decision entirely to the calling agent.
    fn is_blocked_combo(&self, _combo: &KeyCombo) -> bool {
        false
    }

    fn screenshot(
        &self,
        _target: ScreenshotTarget,
        _deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("screenshot"))
    }

    fn screenshot_window_frame(
        &self,
        _window: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<ImageBuffer, AdapterError> {
        Err(AdapterError::not_supported("screenshot_window_frame"))
    }

    fn list_displays(&self, _deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }

    fn focused_window(&self, _deadline: Deadline) -> Result<Option<WindowInfo>, AdapterError> {
        Err(AdapterError::not_supported("focused_window"))
    }

    fn press_key_for_app(
        &self,
        _process: ProcessIdentity,
        _combo: &crate::KeyCombo,
        _policy: crate::InteractionPolicy,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("press_key_for_app"))
    }

    /// Checks the exact focused window before process-scoped key delivery.
    /// Adapters can override this to retain the window identity through their
    /// native delivery gates.
    fn press_key_for_window(
        &self,
        window: &WindowInfo,
        combo: &KeyCombo,
        policy: InteractionPolicy,
        lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let refusal = || {
            AdapterError::stale_ref_because(
                "The named window's exact focus could not be confirmed, so no key was sent",
            )
            .with_suggestion(if policy.is_headed() {
                "Ensure the named window remains active before retrying; a sibling window or another application's menu can hold the keyboard"
            } else {
                "Retry with --headed so the named window is brought forward first, or name the active window"
            })
            .with_details(serde_json::json!({
                "check": "window_active",
                "cause": "exact_window_focus_unconfirmed",
                "physical_delivery_started": false,
                "window_id": window.id,
            }))
            .with_disposition(crate::DeliverySemantics::not_delivered())
        };
        let instance = window
            .process_instance
            .as_deref()
            .filter(|instance| !instance.is_empty())
            .ok_or_else(refusal)?;
        let focused = self
            .focused_window(lease.deadline())
            .map_err(AdapterError::unsent)?;
        if !focused.is_some_and(|focused| {
            focused.id == window.id
                && focused.pid == window.pid
                && focused.process_instance.as_deref() == Some(instance)
        }) {
            return Err(refusal());
        }
        self.press_key_for_app(
            ProcessIdentity::new(window.pid, instance),
            combo,
            policy,
            lease,
        )
    }

    fn wait_for_menu(
        &self,
        _process: ProcessIdentity,
        _open: bool,
        _deadline: Deadline,
    ) -> Result<(), AdapterError> {
        Err(AdapterError::not_supported("wait_for_menu"))
    }

    fn window_op(
        &self,
        _win: &WindowInfo,
        _op: WindowOp,
        _lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        Err(AdapterError::not_supported("window_op"))
    }

    /// Resolves a live window by `WindowInfo.id`, corroborating the match against
    /// `pid` and, when present, `title`. Opaque ids must not be parsed as numeric
    /// outside the adapter; macOS uses `w-<kCGWindowNumber>`.
    fn resolve_window_strict(
        &self,
        _win: &WindowInfo,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Err(AdapterError::not_supported("resolve_window_strict"))
    }

    /// Checks runtime prerequisites without reading or opening notifications.
    /// Waits call this with an operation budget before starting their polling timeout.
    fn check_notification_support(&self, _deadline: Deadline) -> Result<(), AdapterError> {
        Ok(())
    }

    fn list_notifications(
        &self,
        _filter: &NotificationFilter,
        _policy: InteractionPolicy,
        _deadline: Deadline,
        _lease: Option<&InteractionLease>,
    ) -> Result<Vec<NotificationInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_notifications"))
    }

    fn dismiss_notification(
        &self,
        _request: DismissNotificationRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<NotificationInfo, AdapterError> {
        Err(AdapterError::not_supported("dismiss_notification"))
    }

    fn dismiss_all_notifications(
        &self,
        _request: DismissAllNotificationsRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<(Vec<NotificationInfo>, Vec<String>), AdapterError> {
        Err(AdapterError::not_supported("dismiss_all_notifications"))
    }

    fn notification_action(
        &self,
        _request: NotificationActionRequest<'_>,
        _lease: &InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        Err(AdapterError::not_supported("notification_action"))
    }
}

#[cfg(test)]
#[path = "system_tests.rs"]
mod tests;
