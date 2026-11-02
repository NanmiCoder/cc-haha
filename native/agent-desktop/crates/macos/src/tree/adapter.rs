use crate::adapter::{MacOSAdapter, ax_element};
use agent_desktop_core::{
    AccessibilityNode, AdapterError, AppInfo, Deadline, ElementState, LiveElement, NativeHandle,
    ObservationOps, ObservationRequest, ObservationRoot, ObservedTree, Rect, RefEntry, SurfaceInfo,
    TreeOptions, WindowFilter, WindowInfo,
};

impl ObservationOps for MacOSAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        crate::tree::query::observe_tree(root, request)
    }

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

    fn resolve_element_strict(
        &self,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        crate::tree::resolve::resolve_element_with_deadline(entry, deadline)
    }

    fn resolve_locator_anchor(
        &self,
        entry: &RefEntry,
        deadline: Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        crate::tree::resolve::resolve_locator_anchor_with_deadline(entry, deadline)
    }

    fn list_windows(
        &self,
        filter: &WindowFilter,
        deadline: Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        crate::system::app::app_inventory::list_windows_until(
            filter,
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn list_apps(&self, deadline: Deadline) -> Result<Vec<AppInfo>, AdapterError> {
        crate::system::app::app_inventory::list_apps_complete_until(
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn list_apps_inventory(
        &self,
        deadline: Deadline,
    ) -> Result<agent_desktop_core::AppInventory, AdapterError> {
        crate::system::app::app_inventory::list_apps_inventory_until(
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn list_apps_scoped(
        &self,
        name: &str,
        bundle_id: Option<&str>,
        deadline: Deadline,
    ) -> Result<Vec<AppInfo>, AdapterError> {
        crate::system::app::app_inventory::list_apps_scoped_until(
            name,
            bundle_id,
            crate::tree::locator_deadline::from_operation(deadline)?,
        )
    }

    fn list_surfaces(
        &self,
        process: agent_desktop_core::ProcessIdentity,
        deadline: Deadline,
    ) -> Result<Vec<SurfaceInfo>, AdapterError> {
        let identity = crate::system::process::process_identity::require_core(&process)?;
        let surfaces = crate::tree::surface_inventory::list_surfaces_for_pid(
            identity.pid(),
            crate::tree::locator_deadline::from_operation(deadline)?,
        )?;
        crate::system::process::process_identity::require_core(&process)?;
        Ok(surfaces)
    }

    fn hit_test(
        &self,
        handle: &NativeHandle,
        point: agent_desktop_core::Point,
        deadline: Deadline,
    ) -> Result<agent_desktop_core::adapter::hit_test::HitTestResult, AdapterError> {
        crate::tree::hit_test::hit_test_impl(handle, point, deadline)
    }

    fn get_live_value(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<String>, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            Ok(
                crate::actions::post_state::read_element_state(ax_element(handle)?, deadline)?
                    .value,
            )
        }
        #[cfg(not(target_os = "macos"))]
        Err(AdapterError::not_supported("get_live_value"))
    }

    fn get_live_state(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<ElementState>, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            Ok(Some(crate::actions::post_state::read_element_state(
                ax_element(handle)?,
                deadline,
            )?))
        }
        #[cfg(not(target_os = "macos"))]
        Err(AdapterError::not_supported("get_live_state"))
    }

    fn get_text_selection(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            Ok(crate::tree::properties::attributes::selected_text_range(
                ax_element(handle)?,
                deadline,
            ))
        }
        #[cfg(not(target_os = "macos"))]
        Ok(None)
    }

    fn get_live_actions(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Vec<String>>, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            Ok(Some(crate::actions::post_state::read_live_actions(
                ax_element(handle)?,
                deadline,
            )?))
        }
        #[cfg(not(target_os = "macos"))]
        Err(AdapterError::not_supported("get_live_actions"))
    }

    fn get_insertion_caret(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<agent_desktop_core::Rect>, AdapterError> {
        Ok(crate::tree::properties::text_insertion::insertion_caret(
            ax_element(handle)?,
            deadline,
        ))
    }

    fn get_focused_insertion_caret(
        &self,
        process: Option<agent_desktop_core::ProcessId>,
        deadline: Deadline,
    ) -> Result<Option<agent_desktop_core::Rect>, AdapterError> {
        let pid = process
            .map(|process| i32::try_from(process.get()))
            .transpose()
            .map_err(|_| {
                AdapterError::new(
                    agent_desktop_core::ErrorCode::InvalidArgs,
                    "Process id is out of range",
                )
            })?;
        crate::tree::properties::text_insertion::focused_insertion_caret(pid, deadline)
    }

    fn get_live_element(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<LiveElement, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            crate::actions::post_state::read_live_element(ax_element(handle)?, deadline)
        }
        #[cfg(not(target_os = "macos"))]
        Err(AdapterError::not_supported("get_live_element"))
    }

    fn get_element_bounds(
        &self,
        handle: &NativeHandle,
        deadline: Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        #[cfg(target_os = "macos")]
        {
            crate::tree::element_bounds::read_bounds_with_deadline(
                ax_element(handle)?,
                crate::tree::locator_deadline::from_operation(deadline)?,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = handle;
            Err(AdapterError::not_supported("get_element_bounds"))
        }
    }
}
