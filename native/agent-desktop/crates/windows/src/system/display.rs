//! Display enumeration and selection helpers for screenshot targeting.

use agent_desktop_core::{AdapterError, Deadline, DisplayInfo, ErrorCode, Rect};

/// Enumerates the active monitors and reports each with bounds, the primary
/// flag, and `scale` derived from **effective** DPI - the applied value, not
/// the requested one (A10-3's carried warning: a successful scale *request* is
/// not evidence the scale *applied*).
///
/// The dev box and both CI environments have exactly one 96-DPI display
/// (A10-3), so the per-monitor code lands with single-monitor evidence; the
/// multi-monitor path is unverified until it runs on a rig with more than one
/// monitor.
pub(crate) fn list_displays_live(deadline: Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
    deadline.ensure_remaining()?;
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{LPARAM, RECT};
        use windows_sys::Win32::Graphics::Gdi::{
            EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
        };
        use windows_sys::Win32::UI::HiDpi::GetDpiForMonitor;

        struct DisplayEnumState {
            displays: Vec<DisplayInfo>,
            info_read_failed: bool,
            dpi_read_failed: bool,
        }

        let mut state = DisplayEnumState {
            displays: Vec::new(),
            info_read_failed: false,
            dpi_read_failed: false,
        };
        let capture = &mut state as *mut DisplayEnumState;
        unsafe extern "system" fn callback(
            monitor: HMONITOR,
            _hdc: HDC,
            _rect: *mut RECT,
            lparam: LPARAM,
        ) -> i32 {
            let state = unsafe { &mut *(lparam as *mut DisplayEnumState) };
            let mut info = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
                state.info_read_failed = true;
                return 0;
            }
            let primary = info.dwFlags & 1 != 0;
            let mut dpi_x: u32 = 0;
            let mut dpi_y: u32 = 0;
            let effective = unsafe { GetDpiForMonitor(monitor, 0, &mut dpi_x, &mut dpi_y) };
            let Some(scale) = effective_dpi_scale(effective, dpi_x) else {
                state.dpi_read_failed = true;
                return 0;
            };
            state.displays.push(DisplayInfo {
                id: format!("monitor-{}", monitor as usize),
                bounds: crate::system::runtime::win_rect::rect_of(&info.rcMonitor),
                is_primary: primary,
                scale,
            });
            1
        }

        let enumerated = unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(callback),
                capture as isize,
            )
        };
        match classify_enumeration(
            enumerated != 0,
            state.info_read_failed,
            state.dpi_read_failed,
        ) {
            EnumerationOutcome::Completed => {}
            EnumerationOutcome::MonitorInfoUnreadable => {
                return Err(AdapterError::internal(
                    "Could not read a monitor's bounds and primary flag",
                ));
            }
            EnumerationOutcome::DpiUnreadable => {
                return Err(AdapterError::internal(
                    "Could not read a monitor's effective DPI",
                ));
            }
            EnumerationOutcome::EnumerationFailed => return Err(enumeration_failed()),
        }
        primaries_first(&mut state.displays);
        Ok(state.displays)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// What an enumeration pass actually established, kept separate from the
/// Win32 call so the three outcomes can be told apart in a test on any
/// host - the shape `classify_dpi_awareness_call` already uses next door.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnumerationOutcome {
    Completed,
    MonitorInfoUnreadable,
    DpiUnreadable,
    EnumerationFailed,
}

/// `EnumDisplayMonitors` returning zero is a failure, not an empty desktop.
/// Reading it as an empty success made every caller report "no displays
/// attached" for what was an API failure, which is the one answer a caller
/// cannot recover from because it looks like a fact about the machine.
///
/// A monitor whose info cannot be read is the same collapse one monitor
/// down: continuing the enumeration dropped that monitor from the list
/// silently, so a desktop whose every monitor failed answered the same empty
/// success a display-less machine answers. Either unreadable read stops the
/// pass and is reported as itself.
///
/// The callback returns zero on the first failing read, so at most one of the
/// two flags is ever set; the info read runs first, so it is checked first.
pub(crate) fn classify_enumeration(
    enumerated: bool,
    info_read_failed: bool,
    dpi_read_failed: bool,
) -> EnumerationOutcome {
    if info_read_failed {
        return EnumerationOutcome::MonitorInfoUnreadable;
    }
    if dpi_read_failed {
        return EnumerationOutcome::DpiUnreadable;
    }
    if !enumerated {
        return EnumerationOutcome::EnumerationFailed;
    }
    EnumerationOutcome::Completed
}

/// An enumeration that fails returns zero, which is not an empty desktop.
/// Reporting it as an empty success made every caller say "no displays
/// attached" for what was an API failure.
#[cfg(target_os = "windows")]
fn enumeration_failed() -> AdapterError {
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    AdapterError::internal("The attached displays could not be enumerated")
        .with_platform_detail(format!("EnumDisplayMonitors Win32 error {code}"))
        .with_suggestion("Retry once the session has an interactive desktop attached")
}

pub(crate) fn display_at(index: usize, deadline: Deadline) -> Result<DisplayInfo, AdapterError> {
    deadline.ensure_remaining()?;
    let displays = list_displays_live(deadline)?;
    displays.into_iter().nth(index).ok_or_else(|| {
        AdapterError::new(ErrorCode::InvalidArgs, "display index out of range")
            .with_suggestion("Run 'list-displays' to refresh display indexes, then retry.")
    })
}

pub(crate) fn capture_selection(
    expected: &DisplayInfo,
    deadline: Deadline,
) -> Result<(usize, DisplayInfo), AdapterError> {
    deadline.ensure_remaining()?;
    let displays = list_displays_live(deadline)?;
    let (index, live) = displays
        .into_iter()
        .enumerate()
        .find(|(_, display)| display.id == expected.id)
        .ok_or_else(|| missing_display_error(&expected.id))?;
    verify_display_identity(index, expected, &live)?;
    Ok((index, live))
}

pub(crate) fn scale_for_bounds(
    bounds: Option<Rect>,
    deadline: Deadline,
) -> Result<f64, AdapterError> {
    Ok(display_for_bounds(bounds, deadline)?.scale)
}

pub(crate) fn display_for_bounds(
    bounds: Option<Rect>,
    deadline: Deadline,
) -> Result<DisplayInfo, AdapterError> {
    deadline.ensure_remaining()?;
    let displays = list_displays_live(deadline)?;
    select_display(&displays, bounds).cloned()
}

/// Corroborates display identity before and after a capture. The id is a
/// recyclable `monitor-{HMONITOR}` handle, so bounds, primary, and scale are
/// checked together with it rather than trusting the id alone.
pub(crate) fn verify_display_identity(
    index: usize,
    expected: &DisplayInfo,
    current: &DisplayInfo,
) -> Result<(), AdapterError> {
    if display_identity_matches(expected, current) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::InvalidArgs,
        format!(
            "Display at index {index} changed from '{}' to '{}'",
            expected.id, current.id
        ),
    )
    .with_suggestion("Run 'list-displays' to refresh display indexes, then retry."))
}

pub(super) fn display_identity_matches(expected: &DisplayInfo, current: &DisplayInfo) -> bool {
    expected.id == current.id
        && expected.bounds == current.bounds
        && expected.is_primary == current.is_primary
        && expected.scale == current.scale
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
        .ok_or_else(|| {
            AdapterError::new(ErrorCode::InvalidArgs, "no displays enumerated").with_suggestion(
                "Retry after a display is attached, or capture an ExactWindow target instead.",
            )
        })
}

pub(super) fn intersection_area(left: Rect, right: Rect) -> f64 {
    let width = (left.x + left.width).min(right.x + right.width) - left.x.max(right.x);
    let height = (left.y + left.height).min(right.y + right.height) - left.y.max(right.y);
    width.max(0.0) * height.max(0.0)
}

#[cfg(test)]
pub(super) fn scale_for_bounds_in(
    displays: &[DisplayInfo],
    bounds: Option<Rect>,
) -> Result<f64, AdapterError> {
    Ok(select_display(displays, bounds)?.scale)
}

#[cfg(test)]
pub(super) fn capture_selection_in(
    displays: &[DisplayInfo],
    expected: &DisplayInfo,
) -> Result<(usize, DisplayInfo), AdapterError> {
    let (index, live) = displays
        .iter()
        .enumerate()
        .find(|(_, display)| display.id == expected.id)
        .map(|(index, display)| (index, display.clone()))
        .ok_or_else(|| missing_display_error(&expected.id))?;
    verify_display_identity(index, expected, &live)?;
    Ok((index, live))
}

fn missing_display_error(id: &str) -> AdapterError {
    AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("Display '{id}' is no longer active"),
    )
    .with_suggestion("Run 'list-displays' to refresh display indexes, then retry.")
}

/// Turns a raw `GetDpiForMonitor` result into a scale, or `None` when the
/// read cannot be trusted.
///
/// `effective` is the call's own success code (`S_OK` is `0`); a non-zero
/// `dpi_x` on a failed call is leftover, uninitialised-looking data, not
/// evidence. Collapsing a failed read to `1.0` would be a definite claim from
/// no evidence, the shape the Evidence Tri-State rule (`CONCEPTS.md`) forbids
/// - the caller propagates `None` as a read failure instead of guessing.
#[cfg(target_os = "windows")]
pub(super) fn effective_dpi_scale(effective: i32, dpi_x: u32) -> Option<f64> {
    (effective == 0 && dpi_x > 0).then(|| f64::from(dpi_x) / 96.0)
}

/// Orders the display list with the primary first, mirroring macOS's
/// primary-first ordering.
pub(super) fn primaries_first(displays: &mut [DisplayInfo]) {
    displays.sort_by(|left, right| {
        right
            .is_primary
            .cmp(&left.is_primary)
            .then_with(|| left.id.cmp(&right.id))
    });
}

#[cfg(test)]
#[path = "display_tests.rs"]
mod tests;
