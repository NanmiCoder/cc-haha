#[cfg(target_os = "windows")]
use crate::system::runtime::hresult::win32_last_error;
use agent_desktop_core::{
    AdapterError, Deadline, DeliverySemantics, ErrorCode, WindowInfo, WindowOp,
};

use super::window_identity::WindowIdentityEvidence;
use super::window_op_verb::{ShowVerb, verb_is_satisfied};
use super::window_op_wait::wait_for_placement;
use super::window_ops::parse_handle;

const MAX_DIMENSION: f64 = 1_000_000.0;
const MAX_COORDINATE: f64 = 1_000_000.0;
/// Placement re-read tolerance pinned by A21-5 (DWM animation headroom floor).
pub(crate) const PLACEMENT_TOLERANCE_PX: i32 = 8;

/// Refuses a window write to a target that is not dispatching messages.
///
/// `SetWindowPos` uses `SWP_ASYNCWINDOWPOS`, and show verbs use
/// `ShowWindowAsync`, so native writes are queued across input queues and the
/// existing placement readback determines whether they took effect.
///
/// This conservative check runs after identity verification and before the
/// first native write so a destroyed or re-owned handle keeps its stale
/// identity error instead of being classified as unresponsive.
#[cfg(target_os = "windows")]
fn ensure_window_is_pumping(handle: super::window_enum::WindowHandle) -> Result<(), AdapterError> {
    if super::window_enum::window_is_responsive(handle) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::AppUnresponsive,
        "Target window is not processing messages, so the window operation would block",
    )
    .with_suggestion("Wait for the application to recover, or close it with --force"))
}

#[cfg(not(target_os = "windows"))]
fn ensure_window_is_pumping(_handle: super::window_enum::WindowHandle) -> Result<(), AdapterError> {
    Ok(())
}

pub(crate) fn window_op_impl(
    win: &WindowInfo,
    op: WindowOp,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    deadline.ensure_remaining().map_err(before_write)?;
    let handle = parse_handle(&win.id);
    if handle.is_null() {
        return Err(before_write(AdapterError::new(
            ErrorCode::InvalidArgs,
            "window id is not a Windows HWND-shaped id",
        )));
    }
    let Some(evidence) = WindowIdentityEvidence::from_info(handle, win) else {
        return Err(before_write(AdapterError::new(
            ErrorCode::StaleRef,
            "window operation requires a process-instance token on the stored window",
        )));
    };
    evidence.verify_stored().map_err(before_write)?;
    ensure_window_is_pumping(handle).map_err(before_write)?;
    match op {
        WindowOp::Resize { width, height } => resize(handle, &evidence, width, height, deadline),
        WindowOp::Move { x, y } => move_to(handle, &evidence, x, y, deadline),
        WindowOp::Minimize => show_verb(handle, &evidence, ShowVerb::Minimize, deadline),
        WindowOp::Maximize => show_verb(handle, &evidence, ShowVerb::Maximize, deadline),
        WindowOp::Restore => show_verb(handle, &evidence, ShowVerb::Restore, deadline),
    }
}

fn validate_size(width: f64, height: f64) -> Result<(), AdapterError> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Window width and height must be finite, positive, and at most 1000000",
        ));
    }
    Ok(())
}

fn validate_position(x: f64, y: f64) -> Result<(), AdapterError> {
    if !x.is_finite() || !y.is_finite() || x.abs() > MAX_COORDINATE || y.abs() > MAX_COORDINATE {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Window coordinates must be finite and within -1000000..=1000000",
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn resize(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
    width: f64,
    height: f64,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    validate_size(width, height).map_err(before_write)?;
    let cx = round_i32(width).map_err(before_write)?;
    let cy = round_i32(height).map_err(before_write)?;
    ensure_owned_before(evidence)?;
    set_window_pos(handle, None, Some((cx, cy)))?;
    wait_for_placement(deadline, || {
        ensure_owned_after(evidence)?;
        let rect = window_rect(handle)?;
        Ok(within_tolerance(rect.2, cx) && within_tolerance(rect.3, cy))
    })
}

#[cfg(not(target_os = "windows"))]
fn resize(
    _handle: super::window_enum::WindowHandle,
    _evidence: &WindowIdentityEvidence<'_>,
    width: f64,
    height: f64,
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    validate_size(width, height)?;
    Err(AdapterError::not_supported("window_op"))
}

#[cfg(target_os = "windows")]
fn move_to(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
    x: f64,
    y: f64,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    validate_position(x, y).map_err(before_write)?;
    let left = round_i32(x).map_err(before_write)?;
    let top = round_i32(y).map_err(before_write)?;
    ensure_owned_before(evidence)?;
    set_window_pos(handle, Some((left, top)), None)?;
    wait_for_placement(deadline, || {
        ensure_owned_after(evidence)?;
        let rect = window_rect(handle)?;
        Ok(within_tolerance(rect.0, left) && within_tolerance(rect.1, top))
    })
}

#[cfg(not(target_os = "windows"))]
fn move_to(
    _handle: super::window_enum::WindowHandle,
    _evidence: &WindowIdentityEvidence<'_>,
    x: f64,
    y: f64,
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    validate_position(x, y)?;
    Err(AdapterError::not_supported("window_op"))
}

#[cfg(target_os = "windows")]
fn show_verb(
    handle: super::window_enum::WindowHandle,
    evidence: &WindowIdentityEvidence<'_>,
    verb: ShowVerb,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, ShowWindowAsync,
    };

    let command = match verb {
        ShowVerb::Minimize => SW_MINIMIZE,
        ShowVerb::Maximize => SW_MAXIMIZE,
        ShowVerb::Restore => SW_RESTORE,
    };
    ensure_owned_before(evidence)?;
    if unsafe { ShowWindowAsync(handle, command) } == 0 {
        return Err(before_write(win32_last_error("ShowWindowAsync failed")));
    }
    wait_for_placement(deadline, || {
        ensure_owned_after(evidence)?;
        Ok(verb_is_satisfied(verb, placement_show_cmd(handle)?))
    })
}

#[cfg(not(target_os = "windows"))]
fn show_verb(
    _handle: super::window_enum::WindowHandle,
    _evidence: &WindowIdentityEvidence<'_>,
    _verb: ShowVerb,
    _deadline: Deadline,
) -> Result<(), AdapterError> {
    Err(AdapterError::not_supported("window_op"))
}

#[cfg(target_os = "windows")]
fn set_window_pos(
    handle: super::window_enum::WindowHandle,
    origin: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
) -> Result<(), AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
    };

    let (x, y, move_flag) = match origin {
        Some((x, y)) => (x, y, 0),
        None => (0, 0, SWP_NOMOVE),
    };
    let (cx, cy, size_flag) = match size {
        Some((cx, cy)) => (cx, cy, 0),
        None => (0, 0, SWP_NOSIZE),
    };
    let ok = unsafe {
        SetWindowPos(
            handle,
            std::ptr::null_mut(),
            x,
            y,
            cx,
            cy,
            SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOACTIVATE | move_flag | size_flag,
        )
    };
    if ok == 0 {
        return Err(before_write(win32_last_error("SetWindowPos failed")));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn window_rect(
    handle: super::window_enum::WindowHandle,
) -> Result<(i32, i32, i32, i32), AdapterError> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let ok = unsafe { GetWindowRect(handle, &mut rect) };
    if ok == 0 {
        return Err(after_write(win32_last_error("GetWindowRect failed")));
    }
    Ok((
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
    ))
}

#[cfg(target_os = "windows")]
fn placement_show_cmd(handle: super::window_enum::WindowHandle) -> Result<u32, AdapterError> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};

    let mut placement = WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        flags: 0,
        showCmd: 0,
        ptMinPosition: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        ptMaxPosition: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        rcNormalPosition: windows_sys::Win32::Foundation::RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        },
    };
    let ok = unsafe { GetWindowPlacement(handle, &mut placement) };
    if ok == 0 {
        return Err(after_write(win32_last_error("GetWindowPlacement failed")));
    }
    Ok(placement.showCmd)
}

fn ensure_owned_before(evidence: &WindowIdentityEvidence<'_>) -> Result<(), AdapterError> {
    if !evidence.owns_handle_now().map_err(before_write)? {
        return Err(recycled_before_write());
    }
    Ok(())
}

fn ensure_owned_after(evidence: &WindowIdentityEvidence<'_>) -> Result<(), AdapterError> {
    if !evidence.owns_handle_now().map_err(after_write)? {
        return Err(after_write(AdapterError::new(
            ErrorCode::WindowNotFound,
            "Target window handle changed ownership after window operation",
        )));
    }
    Ok(())
}

fn round_i32(value: f64) -> Result<i32, AdapterError> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            "Window geometry is outside the Win32 integer coordinate range",
        ));
    }
    Ok(value.round() as i32)
}

fn within_tolerance(actual: i32, expected: i32) -> bool {
    actual.abs_diff(expected) <= PLACEMENT_TOLERANCE_PX as u32
}

/// The handle's owner changed between `ensure_owned_before`'s read and the
/// native call it guards; the write is refused before anything is sent.
///
/// What this before/after pair cannot promise, stated as a known limit
/// rather than a missed case: no Win32 call lets a caller act on a window
/// only while a given process is certain to still own it, so
/// `ensure_owned_before`'s read and the write it guards remain two distinct
/// steps no matter how close together they run. A recycle landing between
/// them mutates whatever window inherited the handle, and that mutation
/// cannot be reversed. `ensure_owned_after` narrows the exposure rather than
/// closing it - catching a mismatch there only proves the write may have
/// reached a window this operation no longer owns, which is why that
/// failure is reported delivered-unverified rather than not-delivered.
/// Nothing short of an atomic check-and-act primitive, which Win32 does not
/// provide, removes the gap.
fn recycled_before_write() -> AdapterError {
    before_write(AdapterError::new(
        ErrorCode::WindowNotFound,
        "Target window handle changed ownership before window operation",
    ))
}

fn before_write(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::not_delivered())
}

fn after_write(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(test)]
#[path = "window_op_tests.rs"]
mod tests;
