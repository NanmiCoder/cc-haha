//! The live monitor list and the refresh rate, read from the desktop.
//!
//! The refresh source is `GetDeviceCaps(VREFRESH)` on the screen DC, not
//! `EnumDisplaySettings`: the obvious call fails on this class of host and
//! leaves its frequency at zero, which a frame clock would take as an
//! infinite rate. The clamp downstream is the second guard; this is the
//! first.
//!
//! The monitor record is crate-local rather than core's `DisplayInfo`
//! because the overlay needs each monitor's **work area** to place a label
//! and to pick a resting point, and `DisplayInfo` carries none. Extending it
//! would change `list-displays` output on both platforms.

#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::monitors::OverlayMonitor;
#[cfg(target_os = "windows")]
use crate::system::runtime::win_rect::rect_of;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{LPARAM, RECT};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetDC, GetDeviceCaps, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    ReleaseDC, VREFRESH,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::MONITORINFOF_PRIMARY;

#[cfg(target_os = "windows")]
const USER_DEFAULT_SCREEN_DPI: f64 = 96.0;

#[cfg(target_os = "windows")]
pub(crate) fn refresh_hz() -> u32 {
    let screen = unsafe { GetDC(std::ptr::null_mut()) };
    let hz = unsafe { GetDeviceCaps(screen, VREFRESH as i32) };
    unsafe { ReleaseDC(std::ptr::null_mut(), screen) };
    hz.max(0) as u32
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn collect(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    payload: LPARAM,
) -> i32 {
    let collected = unsafe { &mut *(payload as *mut Vec<OverlayMonitor>) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return 0;
    }
    let mut dpi_x = 0u32;
    let mut dpi_y = 0u32;
    let scale = if unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) }
        == 0
        && dpi_x > 0
    {
        f64::from(dpi_x) / USER_DEFAULT_SCREEN_DPI
    } else {
        1.0
    };
    collected.push(OverlayMonitor {
        bounds: rect_of(&info.rcMonitor),
        work_area: rect_of(&info.rcWork),
        scale,
        is_primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
    });
    1
}

/// The monitors this desktop presents, or an empty list.
///
/// An enumeration that fails surfaces here as the empty list, not as a
/// distinct value: the caller treats an empty list as "keep the topology
/// you already had" rather than as "no monitors are attached", so the
/// overlay never repositions itself off a failed read. The failure is
/// traced so a machine that returns empty for a real reason can be told
/// apart in a log from one whose call simply failed.
///
/// A monitor whose info cannot be read stops the walk rather than being
/// skipped, so "empty" covers that case too - a shorter list is the same
/// defect as a wrong one, because the monitor that dropped out is exactly
/// the one a cursor standing on it would need.
#[cfg(target_os = "windows")]
pub(crate) fn monitors() -> Vec<OverlayMonitor> {
    let mut collected: Vec<OverlayMonitor> = Vec::new();
    let enumerated = unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect),
            &mut collected as *mut Vec<OverlayMonitor> as LPARAM,
        )
    };
    completed(enumerated, collected)
}

/// A partial monitor list is discarded rather than returned.
///
/// The callback stops the walk when a monitor's info cannot be read, so a
/// failed enumeration can leave real monitors already collected. Handing
/// those back would place the overlay against a desktop missing whichever
/// monitor failed - a cursor on it would map to the fallback screen and
/// draw somewhere else entirely, silently. An empty list is the caller's
/// signal to keep the topology it already had, which is the only reading
/// that is true of a walk that did not finish.
#[cfg(target_os = "windows")]
pub(super) fn completed(enumerated: i32, collected: Vec<OverlayMonitor>) -> Vec<OverlayMonitor> {
    if enumerated != 0 {
        return collected;
    }
    tracing::debug!(
        discarded = collected.len(),
        "the overlay's monitor enumeration did not complete; the caller keeps its previous topology"
    );
    Vec::new()
}

#[cfg(all(test, target_os = "windows"))]
#[path = "display_probe_tests.rs"]
mod tests;
