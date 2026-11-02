use agent_desktop_core::{Rect, RefEntry};

use crate::tree::AXElement;

#[cfg(target_os = "macos")]
pub(in crate::tree) fn bounds_match_with_deadline(
    element: &AXElement,
    entry: &RefEntry,
    deadline: std::time::Instant,
) -> Result<bool, agent_desktop_core::AdapterError> {
    let Some(expected) = entry.geometry.bounds_hash else {
        return Ok(true);
    };
    Ok(read_bounds_with_deadline(element, deadline)?
        .map(|actual| actual.bounds_hash() == Some(expected))
        .unwrap_or(false))
}

#[cfg(target_os = "macos")]
fn read_bounds_with_deadline(
    element: &AXElement,
    deadline: std::time::Instant,
) -> Result<Option<Rect>, agent_desktop_core::AdapterError> {
    #[cfg(test)]
    if element.0.is_null() {
        return Ok(None);
    }
    let position = super::resolve_ax_read::read_point(
        element,
        accessibility_sys::kAXPositionAttribute,
        deadline,
    )?;
    let size =
        super::resolve_ax_read::read_size(element, accessibility_sys::kAXSizeAttribute, deadline)?;
    Ok(position
        .zip(size)
        .and_then(|(position, size)| crate::tree::element_bounds::rect_from_parts(position, size)))
}
