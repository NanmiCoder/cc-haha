use agent_desktop_core::{
    AdapterError, Deadline, DisplayInfo, ErrorCode, ImageBuffer, Rect, ScreenshotTarget,
};

use super::fullscreen_route::paint;
use super::window_context::grab_failure;
use crate::system::capture::capture_env::CaptureEnv;
use crate::system::x11::capture::grab_rect::GrabRect;
use crate::tree::Extents;

fn invalid(message: String, count: usize) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
        .with_suggestion("Run 'list-displays' to see the displays that exist now")
        .with_details(serde_json::json!({ "display_count": count }))
}

fn at(displays: &[DisplayInfo], index: usize) -> Result<(usize, DisplayInfo), AdapterError> {
    displays
        .get(index)
        .cloned()
        .map(|display| (index, display))
        .ok_or_else(|| {
            invalid(
                format!("Display index {index} is out of range"),
                displays.len(),
            )
        })
}

/// The display a target names and its position in the list: `FullScreen` is
/// the primary (the first when none is marked), `Screen(n)` the nth, and a
/// `Display` the one at its index when it still equals what the caller saw.
pub(crate) fn select(
    displays: &[DisplayInfo],
    target: &ScreenshotTarget,
) -> Result<(usize, DisplayInfo), AdapterError> {
    match target {
        ScreenshotTarget::FullScreen => {
            let primary = displays.iter().position(|display| display.is_primary);
            at(displays, primary.unwrap_or(0))
        }
        ScreenshotTarget::Screen(index) => at(displays, *index),
        ScreenshotTarget::Display { index, expected } => {
            let found = at(displays, *index)?;
            if found.1 == *expected {
                Ok(found)
            } else {
                Err(invalid(
                    format!("Display {index} is no longer the display that was requested"),
                    displays.len(),
                ))
            }
        }
        ScreenshotTarget::ExactWindow(_) => Err(invalid(
            "A window is not a display".to_owned(),
            displays.len(),
        )),
    }
}

fn overlap(display: &DisplayInfo, rect: Rect) -> f64 {
    let width = (display.bounds.x + display.bounds.width).min(rect.x + rect.width)
        - display.bounds.x.max(rect.x);
    let height = (display.bounds.y + display.bounds.height).min(rect.y + rect.height)
        - display.bounds.y.max(rect.y);
    if width > 0.0 && height > 0.0 {
        width * height
    } else {
        0.0
    }
}

/// The scale of the display with the largest overlap with `rect`, one when no
/// display overlaps it.
pub(crate) fn scale_for(displays: &[DisplayInfo], rect: Rect) -> f64 {
    displays
        .iter()
        .map(|display| (overlap(display, rect), display.scale))
        .filter(|(area, _)| *area > 0.0)
        .max_by(|left, right| left.0.total_cmp(&right.0))
        .map_or(1.0, |(_, scale)| scale)
}

fn area_of(bounds: Rect) -> Result<Extents, AdapterError> {
    let whole = |value: f64| -> Option<i32> {
        let rounded = value.round();
        (rounded.abs() <= f64::from(i32::MAX)).then_some(rounded as i32)
    };
    match (
        whole(bounds.x),
        whole(bounds.y),
        whole(bounds.width),
        whole(bounds.height),
    ) {
        (Some(x), Some(y), Some(width), Some(height)) if width > 0 && height > 0 => Ok(Extents {
            x,
            y,
            width,
            height,
        }),
        _ => Err(invalid("The display has no usable rectangle".to_owned(), 0)),
    }
}

pub(crate) fn grab_rect(area: Extents) -> Result<GrabRect, AdapterError> {
    let convert = |value: i32| i16::try_from(value).ok();
    let size = |value: i32| u16::try_from(value).ok();
    match (
        convert(area.x),
        convert(area.y),
        size(area.width),
        size(area.height),
    ) {
        (Some(x), Some(y), Some(width), Some(height)) => Ok(GrabRect {
            x,
            y,
            width,
            height,
        }),
        _ => Err(AdapterError::new(
            ErrorCode::ActionFailed,
            "The display is too large to capture in one image",
        )),
    }
}

/// Captures one display, proving before and after the grab that it is still
/// the display the target named.
pub(crate) fn capture(
    env: &CaptureEnv,
    target: &ScreenshotTarget,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    let displays = env.lookup.displays(deadline)?;
    let (index, display) = select(&displays, target)?;
    let area = area_of(display.bounds)?;
    deadline.ensure_remaining()?;
    let compositing = env
        .grabber
        .compositing(deadline)
        .map_err(|error| grab_failure(error, deadline))?;
    let raw = paint(env, compositing, area, deadline)?;
    let (width, height) = (raw.width, raw.height);
    let rgb = (env.decode)(&raw)?;
    drop(raw);
    deadline.ensure_remaining()?;
    let after = env.lookup.displays(deadline)?;
    if after.get(index) != Some(&display) {
        return Err(invalid(
            "The display changed while it was being captured".to_owned(),
            after.len(),
        ));
    }
    (env.encode)(&rgb, width, height, display.scale)
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;
