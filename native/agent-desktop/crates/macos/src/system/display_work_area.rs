use agent_desktop_core::{AdapterError, Deadline, ErrorCode, Rect};

#[repr(C)]
struct ScreenRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

pub(crate) fn for_window(bounds: Option<Rect>, deadline: Deadline) -> Result<Rect, AdapterError> {
    let display = super::display::display_for_bounds(bounds, deadline)?;
    let display_id = display.id.parse::<u32>().map_err(|_| {
        AdapterError::new(
            ErrorCode::AppUnresponsive,
            "CoreGraphics returned an invalid display identifier",
        )
    })?;
    deadline.ensure_remaining()?;
    crate::system::cocoa_runtime::ensure_cocoa_multithreaded()?;
    let mut visible = ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };
    let found = unsafe { agent_desktop_visible_frame(display_id, &mut visible) };
    deadline.ensure_remaining()?;
    let rect = Rect {
        x: visible.x,
        y: visible.y,
        width: visible.width,
        height: visible.height,
    };
    if !found || !valid(rect) {
        return Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "AppKit returned no valid visible work area for the target display",
        )
        .with_details(serde_json::json!({
            "display_id": display.id,
            "complete": false,
        })));
    }
    Ok(rect)
}

fn valid(rect: Rect) -> bool {
    [rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(f64::is_finite)
        && rect.width > 0.0
        && rect.height > 0.0
}

unsafe extern "C" {
    fn agent_desktop_visible_frame(display_id: u32, output: *mut ScreenRect) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_work_area_rejects_non_finite_or_empty_geometry() {
        assert!(!valid(Rect {
            x: 0.0,
            y: 0.0,
            width: f64::NAN,
            height: 100.0,
        }));
        assert!(!valid(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 100.0,
        }));
    }
}
