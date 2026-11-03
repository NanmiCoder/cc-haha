use agent_desktop_core::{
    AccessibilityNode, ActionOps, AdapterError, AppInfo, ClipboardContent, ClipboardFormat,
    Deadline, DragParams, ElementState, InputOps, InteractionLease, KeyCombo, LiveElement,
    MouseEvent, NativeHandle, ObservationOps, ObservationRequest, ObservationRoot, OperationReport,
    ProcessIdentity, Rect, RefEntry, SnapshotSurface, SurfaceInfo, TreeOptions, WindowFilter,
    WindowInfo,
};
use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The Windows adapter.
///
/// Carries the renderer-activation state the observation loop needs: which
/// processes have **already had** the Chromium settle run for them. Core's
/// loop calls `activate_renderer_accessibility` (the settle) then retries
/// `observe_tree`; the adapter must distinguish a process's pre-settle shell
/// (which re-arms the loop) from its post-settle still-thin tree (which
/// eventually returns the guidance error instead of looping forever). The
/// state is keyed per process, not a single flag: an adapter instance is
/// reused across a batch or an FFI session, so one process settling must
/// never suppress another process's activation.
pub struct WindowsAdapter {
    renderer_activation_attempted: Mutex<HashSet<ProcessIdentity>>,
}

impl WindowsAdapter {
    pub fn new() -> Self {
        Self {
            renderer_activation_attempted: Mutex::new(HashSet::new()),
        }
    }

    /// Records that the Chromium settle has run for `process`, scoped to its
    /// generation (the process-instance token) so a recycled pid never
    /// inherits another process's settle state.
    pub(crate) fn note_renderer_activation_attempted(&self, process: ProcessIdentity) {
        self.activation_set().insert(process);
    }

    /// Whether the Chromium settle has already run for `process`.
    pub(crate) fn renderer_activation_attempted(&self, process: &ProcessIdentity) -> bool {
        self.activation_set().contains(process)
    }

    fn activation_set(&self) -> MutexGuard<'_, HashSet<ProcessIdentity>> {
        self.renderer_activation_attempted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for WindowsAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ObservationOps for WindowsAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<agent_desktop_core::ObservedTree, AdapterError> {
        crate::tree::observe::observe_tree(root, request, self)
    }

    /// The FFI legacy entrypoint: a thin wrapper over the same `observe_tree`
    /// path the binary's `snapshot` uses (mirroring
    /// `crates/macos/src/tree/adapter.rs`).
    fn get_tree(
        &self,
        window: &WindowInfo,
        options: &TreeOptions,
        deadline: Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        self.observe_tree(
            ObservationRoot::Window(window),
            &ObservationRequest::snapshot(options, deadline),
        )?
        .into_accessibility_tree()
    }

    /// Re-resolves a stored ref to a live element, fail-closed - the
    /// drill-down root `snapshot --root @ref` needs.
    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        crate::tree::resolve::resolve_element_strict(entry, deadline)
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        crate::tree::resolve::resolve_anchor::resolve_locator_anchor(entry, deadline)
    }

    /// The five live readers are projections over one shared single-element
    /// read (`crate::tree::live_read`), which corroborates the verified
    /// process token before answering and fails retryable when an essential
    /// slot could not be read, and a dead provider token never satisfies
    /// completeness (A14-9).
    fn get_live_value(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        let read = crate::tree::live_read::read_live_element(handle, deadline)?;
        Ok(crate::tree::live_read::live_value(&read))
    }

    /// The Text pattern selection read, in UTF-16 code units, that `TypeText`
    /// verification uses to predict the post-insertion value. Absent evidence
    /// (no pattern, no selection, any read failure) is `Ok(None)`, which core
    /// degrades to an unverified delivery.
    fn get_text_selection(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        crate::tree::text_selection::get_text_selection(handle, deadline)
    }

    fn get_insertion_caret(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<agent_desktop_core::Rect>, AdapterError> {
        crate::tree::text_insertion::get_insertion_caret(handle, deadline)
    }

    fn get_focused_insertion_caret(
        &self,
        process: Option<agent_desktop_core::ProcessId>,
        deadline: Deadline,
    ) -> Result<Option<agent_desktop_core::Rect>, AdapterError> {
        crate::tree::text_insertion::get_focused_insertion_caret(process, deadline)
    }

    fn get_live_state(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        let read = crate::tree::live_read::read_live_element(handle, deadline)?;
        Ok(Some(crate::tree::live_read::live_state(&read)?))
    }

    fn get_live_actions(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        let read = crate::tree::live_read::read_live_element(handle, deadline)?;
        Ok(Some(crate::tree::live_read::live_actions(&read)?))
    }

    fn get_live_element(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<LiveElement, AdapterError> {
        let read = crate::tree::live_read::read_live_element(handle, deadline)?;
        crate::tree::live_read::live_element(&read)
    }

    fn get_element_bounds(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let read = crate::tree::live_read::read_live_element(handle, deadline)?;
        Ok(crate::tree::live_read::live_bounds(&read))
    }

    fn hit_test(
        &self,
        handle: &NativeHandle,
        point: agent_desktop_core::Point,
        deadline: Deadline,
    ) -> Result<agent_desktop_core::adapter::hit_test::HitTestResult, AdapterError> {
        crate::tree::hit_test::hit_test_impl(handle, point, deadline)
    }

    fn list_windows(
        &self,
        filter: &WindowFilter,
        deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        crate::system::window::window_ops::list_windows_live(filter, deadline)
    }

    fn list_apps(&self, deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        crate::system::app_ops::list_apps_live(deadline)
    }

    /// The per-process surface inventory. Window-backed surfaces carry the
    /// same `w-<hwnd>` id `list_windows` emits, so a surface id feeds the
    /// window observation path unchanged; the menu surface carries the
    /// located menu's own root handle. Shell surfaces are deliberately absent
    /// - they are no process's inventory, and are reached by kind instead.
    fn list_surfaces(
        &self,
        process: ProcessIdentity,
        deadline: Deadline,
    ) -> Result<Vec<SurfaceInfo>, AdapterError> {
        crate::tree::surface_inventory::list_surfaces_for_process(process, deadline)
    }

    /// App-less shell-surface resolution: the read-only half of the shell
    /// surface seam. The shell-surface resolver in `system::shell_surface`
    /// owns the reach mechanics and answers `None` for a surface that is not
    /// presented; this is the translation that turns that absence into the
    /// answer a `snapshot --surface` caller can act on, while a build refusal
    /// passes through unchanged.
    fn resolve_shell_surface(
        &self,
        surface: SnapshotSurface,
        deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        crate::system::shell::shell_surface::resolve_surface(surface, deadline)?
            .ok_or_else(|| crate::system::shell::shell_surface::not_open_error(surface))
    }
}
impl ActionOps for WindowsAdapter {
    fn execute_action(
        &self,
        handle: &NativeHandle,
        request: agent_desktop_core::actions::action_request::ActionRequest,
        lease: &InteractionLease,
    ) -> Result<agent_desktop_core::ActionResult, AdapterError> {
        crate::actions::dispatch::execute_action_impl(handle, request, lease)
    }

    fn scroll_into_view(
        &self,
        handle: &NativeHandle,
        lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::actions::scroll_into_view::scroll_into_view_impl(handle, lease)
    }
}
impl InputOps for WindowsAdapter {
    fn mouse_event(
        &self,
        event: MouseEvent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::pointer_dispatched(&event, false);
        crate::input::mouse::synthesize_mouse(event, lease.deadline())?;
        Ok(report)
    }

    /// A standalone key edge has no daemon to own the hold across a request
    /// boundary, so it rejects the same way macOS's `key_event` does -
    /// the atomic `press`/`type` composers live in the
    /// `execute_action` physical legs, not here.
    fn key_event(
        &self,
        combo: &KeyCombo,
        down: bool,
        _lease: &InteractionLease,
    ) -> Result<(), AdapterError> {
        crate::input::keyboard::reject_standalone_key_state(combo, down)
    }

    fn drag(
        &self,
        params: DragParams,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        let report = OperationReport::drag_dispatched(&params);
        crate::input::drag::synthesize_drag(params, lease.deadline())?;
        Ok(report)
    }

    fn clear_clipboard(&self, lease: &InteractionLease) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::clear(lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-clear", false))
    }

    fn get_clipboard_content(
        &self,
        format: ClipboardFormat,
        deadline: Deadline,
    ) -> Result<Option<ClipboardContent>, AdapterError> {
        crate::input::clipboard::get_clipboard_content(format, deadline)
    }

    fn set_clipboard_content(
        &self,
        content: &ClipboardContent,
        lease: &InteractionLease,
    ) -> Result<OperationReport, AdapterError> {
        crate::input::clipboard::set_content(content, lease.deadline())?;
        Ok(OperationReport::clipboard_written("clipboard-set", false))
    }
}
