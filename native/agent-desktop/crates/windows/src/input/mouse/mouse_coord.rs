//! Physical-pixel `Point` -> `SendInput` normalized-absolute coordinate
//! transform.
//!
//! `MOUSEEVENTF_ABSOLUTE` normalizes against the primary monitor only
//! (A4-3/A10-6): a point outside the primary rect needs
//! `MOUSEEVENTF_VIRTUALDESK`, normalized against the full virtual screen
//! instead. Core hands physical-pixel points across the virtual screen
//! (`Point`, from UIA `BoundingRectangle` under `PER_MONITOR_AWARE_V2`), so
//! every point this module receives already speaks that space; the job here
//! is choosing which rect to normalize against and doing the division.

use agent_desktop_core::Point;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NormalizedPoint {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) virtual_desktop: bool,
}

const NORMALIZED_MAX: f64 = 65535.0;

pub(crate) fn normalize_point(point: &Point) -> NormalizedPoint {
    imp::normalize_point(point)
}

fn normalize_axis(coordinate: f64, origin: i32, extent: i32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    let relative = coordinate - f64::from(origin);
    let scaled = (relative * NORMALIZED_MAX) / f64::from(extent - 1);
    scaled.round().clamp(0.0, NORMALIZED_MAX) as i32
}

fn within_rect(point: &Point, left: i32, top: i32, width: i32, height: i32) -> bool {
    width > 0
        && height > 0
        && point.x >= f64::from(left)
        && point.x < f64::from(left) + f64::from(width)
        && point.y >= f64::from(top)
        && point.y < f64::from(top) + f64::from(height)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{NormalizedPoint, normalize_axis, within_rect};
    use agent_desktop_core::Point;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    pub(super) fn normalize_point(point: &Point) -> NormalizedPoint {
        let (primary_width, primary_height) = primary_screen_metrics();
        if within_rect(point, 0, 0, primary_width, primary_height) {
            return NormalizedPoint {
                x: normalize_axis(point.x, 0, primary_width),
                y: normalize_axis(point.y, 0, primary_height),
                virtual_desktop: false,
            };
        }
        let (left, top, width, height) = crate::tree::hit_test::virtual_screen_metrics();
        NormalizedPoint {
            x: normalize_axis(point.x, left, width),
            y: normalize_axis(point.y, top, height),
            virtual_desktop: true,
        }
    }

    pub(crate) fn primary_screen_metrics() -> (i32, i32) {
        unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::NormalizedPoint;
    use agent_desktop_core::Point;

    pub(super) fn normalize_point(_point: &Point) -> NormalizedPoint {
        NormalizedPoint {
            x: 0,
            y: 0,
            virtual_desktop: false,
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::primary_screen_metrics;

#[cfg(all(test, target_os = "windows"))]
#[path = "mouse_coord_tests.rs"]
mod tests;
