use agent_desktop_core::Deadline;

use super::hit_test::corroborate::element_root_hwnd;
use crate::tree::automation::automation_client;
use crate::tree::element::UIAElement;
use crate::tree::properties::element_properties::ElementProperties;
use crate::tree::properties::property_ids::TreeProperty;
use crate::tree::properties::property_outcome::{PropertyOutcome, PropertyValue};

/// Whether the element's owning top-level window is minimized right now.
///
/// `None` answers nothing: the budget expired, the client or walker would
/// not build, or the climb never reached a window. Callers treat `None` as
/// unknown and change nothing, because a failed window question must never
/// invent an offscreen state.
pub(crate) fn owning_window_minimized(element: &UIAElement, deadline: Deadline) -> Option<bool> {
    deadline.ensure_remaining().ok()?;
    let client = automation_client().ok()?;
    let walker = client.get_raw_view_walker().ok()?;
    let root = element_root_hwnd(element, &walker, deadline).ok()??;
    Some(unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(root as *mut std::ffi::c_void) != 0
    })
}

/// WinForms reports unclipped descendants as on-screen; intersect their scroll viewports.
pub(crate) fn outside_scroll_viewports(
    element: &UIAElement,
    deadline: Deadline,
) -> Result<bool, agent_desktop_core::AdapterError> {
    use crate::tree::automation::uia_error;
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker_source::{parent_step, viewport_bounds};
    let Some(mut visible) = read_one(element, TreeProperty::BoundingRectangle)
        .bounds()
        .known()
        .copied()
    else {
        return Ok(false);
    };
    let client = automation_client()?;
    let walker = client
        .get_raw_view_walker()
        .map_err(|error| uia_error(&error, "read scroll ancestors"))?;
    let mut current = element.clone();
    for _ in 0..crate::tree::walk::walker::DEFAULT_MAX_RAW_DEPTH {
        deadline.ensure_remaining()?;
        current = match parent_step(&walker, &current) {
            Ok(Some(parent)) => parent,
            Ok(None) => return Ok(false),
            Err(()) => {
                return Err(agent_desktop_core::AdapterError::new(
                    agent_desktop_core::ErrorCode::AppUnresponsive,
                    "Could not inspect scroll clipping",
                ));
            }
        };
        if read_one(&current, TreeProperty::ScrollAvailable).flag() != Some(true) {
            continue;
        }
        if let Some(viewport) = viewport_bounds(&current)? {
            match crate::tree::hit_test::intersect_rects(visible, viewport) {
                Some(intersection) => visible = intersection,
                None => return Ok(true),
            }
        }
    }
    Err(agent_desktop_core::AdapterError::new(
        agent_desktop_core::ErrorCode::AppUnresponsive,
        "Scroll ancestor traversal exceeded its limit",
    ))
}

/// Reports a minimized owner's whole subtree offscreen in the read set.
///
/// A minimized top-level window keeps reporting usable rectangles and a
/// clear `IsOffscreen` on its descendants (A14-8 measured the descendants
/// false throughout on the COM stack), so the visibility gate and `is
/// visible` both read the element as shown. Overwriting the one flag carries
/// the window truth into every projection the shared read serves, without
/// touching what the walk or the resolver collect on their own paths.
pub(crate) fn stamp_minimized_offscreen(properties: &mut ElementProperties) {
    properties.set(
        TreeProperty::IsOffscreen,
        PropertyOutcome::Known(PropertyValue::Flag(true)),
    );
}

#[cfg(test)]
#[path = "minimized_tests.rs"]
mod tests;
