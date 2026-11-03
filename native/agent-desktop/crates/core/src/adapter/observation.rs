use crate::{
    AccessibilityNode, AdapterError, AppInfo, Deadline, ErrorCode, Rect, SnapshotSurface,
    SurfaceInfo, WindowInfo,
    adapter::live_element::LiveElement,
    adapter::native_handle::NativeHandle,
    locator::live_locator::{ObservationRequest, ObservationRoot, ObservedTree},
    refs::RefEntry,
    system::window_filter::WindowFilter,
    tree::element_state::ElementState,
    tree::tree_options::TreeOptions,
};

pub(crate) fn optional_live_read<T>(
    result: Result<Option<T>, AdapterError>,
) -> Result<Option<T>, AdapterError> {
    match result {
        Ok(value) => Ok(value),
        Err(err) if is_live_read_unsupported(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

fn is_live_read_unsupported(err: &AdapterError) -> bool {
    matches!(
        err.code,
        ErrorCode::PlatformNotSupported | ErrorCode::ActionNotSupported
    )
}

pub trait ObservationOps: Send + Sync {
    /// Whether this resolved handle denotes a protocol object with no screen
    /// position, rather than a native control whose geometry is unreadable.
    /// Only headless semantic delivery can use this fact; fresh identity,
    /// complete state and action capability are still required.
    fn is_nonspatial_target(&self, _handle: &NativeHandle) -> bool {
        false
    }

    fn observe_tree(
        &self,
        _root: ObservationRoot<'_>,
        _request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        Err(AdapterError::not_supported("observe_tree"))
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_windows"))
    }

    fn list_apps(&self, _deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_apps"))
    }

    fn list_apps_inventory(&self, deadline: Deadline) -> Result<crate::AppInventory, AdapterError> {
        Ok(crate::AppInventory {
            apps: self.list_apps(deadline)?,
            skipped: Vec::new(),
        })
    }

    fn list_apps_scoped(
        &self,
        name: &str,
        bundle_id: Option<&str>,
        deadline: Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        Ok(self
            .list_apps(deadline)?
            .into_iter()
            .filter(|app| {
                app.matches_identifier(name)
                    && bundle_id.is_none_or(|expected| {
                        app.bundle_id
                            .as_deref()
                            .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
                    })
            })
            .collect())
    }

    /// Allows filtering before presentation enrichment. Skipped records describe
    /// incomplete evidence within the query; exact lookups cannot authorize
    /// mutation until that inventory is complete.
    fn query_app_inventory(
        &self,
        query: crate::AppInventoryQuery<'_>,
        deadline: Deadline,
    ) -> Result<crate::AppInventory, AdapterError> {
        let name = match query {
            crate::AppInventoryQuery::All => return self.list_apps_inventory(deadline),
            crate::AppInventoryQuery::Exact { name, bundle_id } => {
                return Ok(crate::AppInventory {
                    apps: self.list_apps_scoped(name, bundle_id, deadline)?,
                    skipped: Vec::new(),
                });
            }
            crate::AppInventoryQuery::NameOrAlias(name) => name,
        };
        let mut inventory = self.list_apps_inventory(deadline)?;
        inventory
            .apps
            .retain(|app| query.matches_display_name(&app.name));
        let aliased = match self.list_apps_scoped(name, None, deadline) {
            Ok(apps) => apps,
            Err(err) if err.code == ErrorCode::PlatformNotSupported => Vec::new(),
            Err(err) => return Err(err),
        };
        for app in aliased {
            if !inventory.apps.iter().any(|kept| kept.pid == app.pid) {
                inventory.apps.push(app);
            }
        }
        Ok(inventory)
    }

    fn get_tree(
        &self,
        _win: &WindowInfo,
        _opts: &TreeOptions,
        _deadline: Deadline,
    ) -> Result<AccessibilityNode, AdapterError> {
        Err(AdapterError::not_supported("get_tree"))
    }

    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::not_supported("resolve_element_strict"))
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &RefEntry,
        _deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Err(AdapterError::not_supported("resolve_locator_anchor"))
    }

    fn list_surfaces(
        &self,
        _process: crate::ProcessIdentity,
        _deadline: Deadline,
    ) -> Result<Vec<SurfaceInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_surfaces"))
    }

    /// Reads an already-open OS-chrome surface - the Start menu, the taskbar,
    /// the notification area, the Action Center - into the window identity
    /// the observation stack consumes. It only reads what is already up and
    /// never raises anything, which is why it takes a deadline and no
    /// interaction policy. An adapter that does not implement it answers with
    /// this default, and core's app-less surface resolution falls through to
    /// the application-owned path exactly as it did before the seam existed.
    fn resolve_shell_surface(
        &self,
        _surface: SnapshotSurface,
        _deadline: Deadline,
    ) -> Result<WindowInfo, AdapterError> {
        Err(AdapterError::not_supported("resolve_shell_surface"))
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Err(AdapterError::not_supported("get_live_value"))
    }

    /// Selected text offsets in UTF-16 code units, or unavailable evidence.
    fn get_text_selection(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        Err(AdapterError::not_supported("get_text_selection"))
    }

    fn get_live_state(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        Err(AdapterError::not_supported("get_live_state"))
    }

    fn get_live_actions(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        Err(AdapterError::not_supported("get_live_actions"))
    }

    fn get_live_element(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<LiveElement, AdapterError> {
        Err(AdapterError::not_supported("get_live_element"))
    }

    fn get_element_bounds(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::not_supported("get_element_bounds"))
    }

    /// Screen bounds of a text element's insertion point: a caret-wide rect as
    /// tall as the line it sits on. `None` when the element reports no
    /// insertion point.
    fn get_insertion_caret(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::not_supported("get_insertion_caret"))
    }

    /// The insertion point of the text element that has keyboard focus, in
    /// `process` when given and system-wide otherwise, as
    /// [`get_insertion_caret`](Self::get_insertion_caret) reports it. `None`
    /// when the focused element is not a text element or has no insertion point.
    fn get_focused_insertion_caret(
        &self,
        _process: Option<crate::ProcessId>,
        _deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        Err(AdapterError::not_supported("get_focused_insertion_caret"))
    }

    /// Fresh pointer geometry and visibility from one observation when supported.
    /// The default preserves bounds-first reads and optional state evidence.
    fn observe_pointer(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<crate::PointerObservation, AdapterError> {
        let bounds = self.get_element_bounds(handle, deadline)?;
        let states = optional_live_read(self.get_live_state(handle, deadline))?
            .map(|state| state.states)
            .unwrap_or_default();
        Ok(crate::PointerObservation { bounds, states })
    }

    /// Why no pointer can be aimed at this target, when the adapter has proved
    /// that its screen position cannot be known, not merely that it is unread
    /// yet. Waiting cannot help, so a request that needs the position is
    /// refused with this error instead of retried until its deadline.
    fn pointer_position_refusal(
        &self,
        _handle: &NativeHandle,
        _deadline: Deadline,
    ) -> Option<AdapterError> {
        None
    }

    fn hit_test(
        &self,
        handle: &NativeHandle,
        point: crate::Point,
        _deadline: Deadline,
    ) -> Result<crate::adapter::hit_test::HitTestResult, AdapterError> {
        let _ = (handle, point);
        Err(AdapterError::not_supported("hit_test"))
    }

    /// Strict receiver proof for a physical pointer move that has no element
    /// action to carry it. An adapter that can prove who receives the pointer
    /// refuses with a `not_delivered` error when the target does not.
    fn confirm_pointer_receiver(
        &self,
        entry: &RefEntry,
        point: crate::Point,
        deadline: Deadline,
    ) -> Result<(), AdapterError> {
        let _ = (entry, point, deadline);
        Ok(())
    }
}

#[cfg(test)]
#[path = "observation_tests.rs"]
mod tests;
