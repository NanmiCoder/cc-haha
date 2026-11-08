use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Rect};

use super::AXElement;

#[cfg(target_os = "macos")]
pub(crate) fn rect_from_parts(
    point: core_graphics::geometry::CGPoint,
    size: core_graphics::geometry::CGSize,
) -> Option<Rect> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || !size.width.is_finite()
        || !size.height.is_finite()
    {
        return None;
    }
    Some(Rect {
        x: point.x,
        y: point.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn read_bounds_with_deadline(
    element: &AXElement,
    deadline: std::time::Instant,
) -> Result<Option<Rect>, agent_desktop_core::AdapterError> {
    let point = super::resolve::resolve_ax_read::read_point(element, "AXPosition", deadline)?;
    let size = super::resolve::resolve_ax_read::read_size(element, "AXSize", deadline)?;
    Ok(point
        .zip(size)
        .and_then(|(point, size)| rect_from_parts(point, size)))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_bounds_with_deadline(
    _element: &AXElement,
    _deadline: std::time::Instant,
) -> Result<Option<Rect>, agent_desktop_core::AdapterError> {
    Ok(None)
}

pub(crate) fn owning_window_bounds(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    crate::tree::properties::attributes::set_messaging_timeout(element, deadline)?;
    let window = first_owning_container(|attribute| {
        crate::tree::properties::attributes::copy_element_attr_result(element, attribute, deadline)
    })
    .map_err(|(attribute, error)| read_error(attribute, error))?;
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    let Some(window) = window else {
        return Ok(None);
    };
    crate::tree::element_bounds::read_bounds_with_deadline(
        &window,
        super::locator_deadline::from_operation(deadline)?,
    )
}

pub(crate) fn clips_descendants(role: &str) -> bool {
    matches!(
        role,
        "AXWindow" | "AXScrollArea" | "AXWebArea" | "AXSheet" | "AXPopover"
    )
}

pub(crate) fn intersect_rects(left: Rect, right: Rect) -> Option<Rect> {
    let x = left.x.max(right.x);
    let y = left.y.max(right.y);
    let width = (left.x + left.width).min(right.x + right.width) - x;
    let height = (left.y + left.height).min(right.y + right.height) - y;
    (width > 0.0 && height > 0.0).then_some(Rect {
        x,
        y,
        width,
        height,
    })
}

pub(crate) fn clipped_viewport(
    parent: Option<Rect>,
    role: &str,
    bounds: Option<Rect>,
) -> Option<Rect> {
    if !clips_descendants(role) {
        return parent;
    }
    let parent = parent?;
    let bounds = bounds?;
    Some(intersect_rects(parent, bounds).unwrap_or(Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    }))
}

pub(crate) fn ancestor_viewport(
    element: &AXElement,
    deadline: Deadline,
) -> Result<Option<Rect>, AdapterError> {
    let mut viewport = owning_window_bounds(element, deadline)?;
    if viewport.is_none() {
        return Ok(None);
    }
    let instant = super::locator_deadline::from_operation(deadline)?;
    let mut current = super::surface_read::element(element, "AXParent", instant)?;
    for _ in 0..super::properties::element::ABSOLUTE_MAX_DEPTH {
        let Some(parent) = current else {
            return Ok(viewport);
        };
        let Some(role) = super::surface_read::string(&parent, "AXRole", instant)? else {
            return Ok(None);
        };
        if role == "AXApplication" {
            return Ok(viewport);
        }
        if clips_descendants(&role) {
            viewport = clipped_viewport(
                viewport,
                &role,
                read_bounds_with_deadline(&parent, instant)?,
            );
        }
        if role == "AXWindow" {
            return Ok(viewport);
        }
        current = super::surface_read::element(&parent, "AXParent", instant)?;
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Clipping ancestry exceeded its bounded depth",
    ))
}

/// The viewport an element is clipped by. `AXTopLevelUIElement` is not a
/// substitute: for menu content it resolves to the menu bar, a 29-point strip
/// that reports every open menu item as offscreen. An element with no window is
/// drawn on its own surface, so its clipping viewport is simply unknown.
fn first_owning_container(
    mut read: impl FnMut(&'static str) -> Result<Option<AXElement>, i32>,
) -> Result<Option<AXElement>, (&'static str, i32)> {
    read("AXWindow").map_err(|error| ("AXWindow", error))
}

fn read_error(attribute: &str, error: i32) -> AdapterError {
    AdapterError::new(
        if error == accessibility_sys::kAXErrorCannotComplete {
            ErrorCode::Timeout
        } else if error == accessibility_sys::kAXErrorAPIDisabled {
            ErrorCode::PermDenied
        } else if error == accessibility_sys::kAXErrorInvalidUIElement {
            ErrorCode::StaleRef
        } else {
            ErrorCode::ActionFailed
        },
        format!("Could not read {attribute} for live state"),
    )
    .with_details(serde_json::json!({ "attribute": attribute, "ax_error": error }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, width: f64) -> Rect {
        Rect {
            x,
            y: 0.0,
            width,
            height: 100.0,
        }
    }

    #[test]
    fn only_clipping_containers_narrow_the_viewport() {
        let window = Some(rect(0.0, 500.0));
        assert_eq!(
            clipped_viewport(window, "AXGroup", Some(rect(20.0, 10.0))),
            window
        );
        assert_eq!(
            clipped_viewport(window, "AXScrollArea", Some(rect(20.0, 100.0))),
            Some(rect(20.0, 100.0))
        );
    }

    #[test]
    fn disjoint_viewports_remain_known_empty_through_descendants() {
        let empty = clipped_viewport(
            Some(rect(0.0, 100.0)),
            "AXScrollArea",
            Some(rect(200.0, 100.0)),
        );
        assert_eq!(
            crate::tree::state_reader::offscreen(Some(rect(-50.0, 500.0)), empty),
            Some(true)
        );
        let nested = clipped_viewport(empty, "AXScrollArea", Some(rect(-50.0, 500.0)));
        assert_eq!(
            crate::tree::state_reader::offscreen(Some(rect(-50.0, 500.0)), nested),
            Some(true)
        );
    }

    #[test]
    fn missing_clipping_geometry_is_unknown_not_empty() {
        assert_eq!(
            clipped_viewport(Some(rect(0.0, 100.0)), "AXScrollArea", None),
            None
        );
        assert_eq!(
            clipped_viewport(None, "AXScrollArea", Some(rect(0.0, 100.0))),
            None
        );
    }
    /// A menu item's `AXTopLevelUIElement` is the menu bar, whose 29-point height
    /// clips every open menu item. A window-less element therefore reports no
    /// clipping viewport rather than a wrong one.
    #[test]
    fn a_window_less_element_reports_no_clipping_viewport() {
        let mut attributes = Vec::new();
        let container = first_owning_container(|attribute| {
            attributes.push(attribute);
            Ok(None)
        })
        .unwrap();

        assert!(container.is_none());
        assert_eq!(attributes, ["AXWindow"]);
    }

    #[test]
    fn incomplete_window_read_never_falls_through_to_a_weaker_container() {
        for error in [
            accessibility_sys::kAXErrorCannotComplete,
            accessibility_sys::kAXErrorInvalidUIElement,
        ] {
            let calls = std::cell::Cell::new(0);
            let result = first_owning_container(|_| {
                calls.set(calls.get() + 1);
                Err(error)
            });

            let failure = match result {
                Err(failure) => failure,
                Ok(_) => panic!("incomplete AXWindow read must fail"),
            };
            assert_eq!(failure, ("AXWindow", error));
            assert_eq!(calls.get(), 1);
        }
    }
}
