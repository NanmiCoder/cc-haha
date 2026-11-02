use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, ErrorCode, Rect};

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use core_graphics::display::CGDisplay;

    pub fn list_displays_impl(deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        let mut displays = raw_display_inventory(deadline)?;
        order_public_displays(&mut displays);
        Ok(displays
            .into_iter()
            .map(|(_, _, display)| display)
            .collect())
    }

    pub fn display_at(index: usize, deadline: Deadline) -> Result<DisplayInfo, AdapterError> {
        let displays = list_displays_impl(deadline)?;
        displays
            .into_iter()
            .nth(index)
            .ok_or_else(|| AdapterError::new(ErrorCode::InvalidArgs, "display index out of range"))
    }

    pub fn capture_selection(
        expected: &DisplayInfo,
        deadline: Deadline,
    ) -> Result<(usize, DisplayInfo), AdapterError> {
        capture_selection_in(raw_display_inventory(deadline)?, &expected.id)
            .ok_or_else(|| missing_display_error(&expected.id))
    }

    pub fn display_at_capture_index(
        raw_index: usize,
        deadline: Deadline,
    ) -> Result<DisplayInfo, AdapterError> {
        display_at_capture_index_in(raw_display_inventory(deadline)?, raw_index)
            .ok_or_else(|| missing_display_error(&raw_index.to_string()))
    }

    pub fn scale_for_bounds(bounds: Option<Rect>, deadline: Deadline) -> Result<f64, AdapterError> {
        Ok(display_for_bounds(bounds, deadline)?.scale)
    }

    pub fn display_for_bounds(
        bounds: Option<Rect>,
        deadline: Deadline,
    ) -> Result<DisplayInfo, AdapterError> {
        let displays = list_displays_impl(deadline)?;
        select_display(&displays, bounds).cloned()
    }

    #[cfg(test)]
    pub(super) fn scale_for_bounds_in(
        displays: &[DisplayInfo],
        bounds: Option<Rect>,
    ) -> Result<f64, AdapterError> {
        Ok(select_display(displays, bounds)?.scale)
    }

    fn select_display(
        displays: &[DisplayInfo],
        bounds: Option<Rect>,
    ) -> Result<&DisplayInfo, AdapterError> {
        let selected = bounds.and_then(|bounds| {
            displays
                .iter()
                .max_by(|left, right| {
                    intersection_area(bounds, left.bounds)
                        .total_cmp(&intersection_area(bounds, right.bounds))
                })
                .filter(|display| intersection_area(bounds, display.bounds) > 0.0)
        });
        selected
            .or_else(|| displays.iter().find(|display| display.is_primary))
            .or_else(|| displays.first())
            .ok_or_else(|| display_inventory_error("CoreGraphics returned no active displays"))
    }

    pub(super) fn intersection_area(left: Rect, right: Rect) -> f64 {
        let width = (left.x + left.width).min(right.x + right.width) - left.x.max(right.x);
        let height = (left.y + left.height).min(right.y + right.height) - left.y.max(right.y);
        width.max(0.0) * height.max(0.0)
    }

    fn display_info(display: &CGDisplay, main_id: u32) -> Result<DisplayInfo, AdapterError> {
        let bounds = display.bounds();
        let mode = display.display_mode().ok_or_else(|| {
            display_inventory_error("CoreGraphics returned no current display mode")
        })?;
        let scale = scale_from_mode(mode.width() as f64, mode.pixel_width() as f64)?;
        Ok(DisplayInfo {
            id: display.id.to_string(),
            bounds: Rect {
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.size.width,
                height: bounds.size.height,
            },
            is_primary: display.id == main_id,
            scale,
        })
    }

    fn raw_display_inventory(
        deadline: Deadline,
    ) -> Result<Vec<(u32, usize, DisplayInfo)>, AdapterError> {
        deadline.ensure_remaining()?;
        let display_ids = CGDisplay::active_displays()
            .map_err(|_| AdapterError::internal("Failed to enumerate active displays"))?;
        deadline.ensure_remaining()?;
        let main_id = CGDisplay::main().id;
        display_ids
            .into_iter()
            .enumerate()
            .map(|(raw_index, display_id)| {
                deadline.ensure_remaining()?;
                Ok((
                    display_id,
                    raw_index,
                    display_info(&CGDisplay::new(display_id), main_id)?,
                ))
            })
            .collect()
    }

    pub(super) fn order_public_displays(displays: &mut [(u32, usize, DisplayInfo)]) {
        displays.sort_by_key(|(id, _, display)| (!display.is_primary, *id));
    }

    pub(super) fn capture_selection_in(
        displays: Vec<(u32, usize, DisplayInfo)>,
        expected_id: &str,
    ) -> Option<(usize, DisplayInfo)> {
        displays
            .into_iter()
            .find(|(_, _, display)| display.id == expected_id)
            .map(|(_, raw_index, display)| (raw_index, display))
    }

    pub(super) fn display_at_capture_index_in(
        displays: Vec<(u32, usize, DisplayInfo)>,
        raw_index: usize,
    ) -> Option<DisplayInfo> {
        displays
            .into_iter()
            .find(|(_, index, _)| *index == raw_index)
            .map(|(_, _, display)| display)
    }

    pub(super) fn scale_from_mode(point_width: f64, pixel_width: f64) -> Result<f64, AdapterError> {
        if !point_width.is_finite()
            || !pixel_width.is_finite()
            || point_width <= 0.0
            || pixel_width <= 0.0
        {
            return Err(display_inventory_error(
                "CoreGraphics returned invalid display mode dimensions",
            ));
        }
        Ok(pixel_width / point_width)
    }

    fn display_inventory_error(message: &str) -> AdapterError {
        AdapterError::new(ErrorCode::AppUnresponsive, message)
            .with_suggestion("Retry after WindowServer finishes updating the display inventory")
    }

    fn missing_display_error(id: &str) -> AdapterError {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Display '{id}' is no longer active"),
        )
        .with_suggestion("Run 'list-displays' to refresh display indexes, then retry.")
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn list_displays_impl(_deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }

    pub fn display_at(_index: usize, _deadline: Deadline) -> Result<DisplayInfo, AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }

    pub fn capture_selection(
        _expected: &DisplayInfo,
        _deadline: Deadline,
    ) -> Result<(usize, DisplayInfo), AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }

    pub fn display_at_capture_index(
        _raw_index: usize,
        _deadline: Deadline,
    ) -> Result<DisplayInfo, AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }

    pub fn scale_for_bounds(
        _bounds: Option<Rect>,
        _deadline: Deadline,
    ) -> Result<f64, AdapterError> {
        Ok(1.0)
    }

    pub fn display_for_bounds(
        _bounds: Option<Rect>,
        _deadline: Deadline,
    ) -> Result<DisplayInfo, AdapterError> {
        Err(AdapterError::not_supported("list_displays"))
    }
}

pub(crate) use imp::{
    capture_selection, display_at, display_at_capture_index, display_for_bounds,
    list_displays_impl, scale_for_bounds,
};

#[cfg(all(test, target_os = "macos"))]
#[path = "display_tests.rs"]
mod tests;
