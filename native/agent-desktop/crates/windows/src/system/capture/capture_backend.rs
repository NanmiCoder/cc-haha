//! Capture backend seam: support predicate, modern entry, and precedence.
//!
//! Production prefers Modern (`Windows.Graphics.Capture`) when
//! [`modern_is_supported`] is true, and falls back to Legacy on unsupported
//! or modern failure. Tests force unavailable or fail-after-available through
//! [`test_hooks`].

use std::time::Duration;

#[cfg(test)]
use agent_desktop_core::ErrorCode;
use agent_desktop_core::{AdapterError, Deadline, ImageBuffer};

use super::capture_display::capture_display_at;
use super::capture_modern;
use super::capture_window::capture_window;
use crate::system::window::window_enum::WindowHandle;

/// Floor reserved for Legacy when Modern is attempted (A22-style silent
/// degradation must not starve the fallback of its deadline).
const LEGACY_DEADLINE_FLOOR: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug)]
pub(crate) enum CaptureSubject {
    Window {
        handle: WindowHandle,
        scale_factor: f64,
    },
    Display {
        index: usize,
    },
}

/// Whether the modern capture backend can serve this session.
pub(crate) fn modern_is_supported() -> bool {
    #[cfg(test)]
    {
        if test_hooks::force_unsupported() {
            return false;
        }
        if test_hooks::force_fail_after_available() {
            return true;
        }
    }
    capture_modern::modern_is_supported()
}

/// Modern capture entry. Delegates to the WGC backend.
pub(crate) fn capture_modern(
    subject: CaptureSubject,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    #[cfg(test)]
    {
        if test_hooks::force_fail_after_available() {
            if test_hooks::consume_modern_slice() {
                burn_deadline(deadline);
            }
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "modern capture forced failure after reporting available",
            ));
        }
    }
    match subject {
        CaptureSubject::Window {
            handle,
            scale_factor,
        } => capture_modern::capture_window(handle, scale_factor, deadline),
        CaptureSubject::Display { index } => capture_modern::capture_display(index, deadline),
    }
}

pub(crate) fn capture_legacy(
    subject: CaptureSubject,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    match subject {
        CaptureSubject::Window {
            handle,
            scale_factor,
        } => {
            let handle = handle as usize;
            super::native_call::capture(deadline, "window-capture", move || {
                capture_window(handle as WindowHandle, scale_factor, deadline)
            })
        }
        CaptureSubject::Display { index } => capture_display_at(index, deadline),
    }
}

/// Prefer Modern when supported; fall back to Legacy on unsupported or failure.
pub(crate) fn capture_with_precedence(
    subject: CaptureSubject,
    deadline: Deadline,
) -> Result<ImageBuffer, AdapterError> {
    deadline.ensure_remaining()?;
    let mut modern_failure = None;
    if modern_is_supported() {
        let modern_deadline = modern_deadline_slice(deadline);
        match capture_modern(subject, modern_deadline) {
            Ok(image) => return Ok(image),
            Err(error) => {
                tracing::debug!(
                    error = %error,
                    "modern capture unavailable or failed; falling back to legacy"
                );
                modern_failure = Some(error);
            }
        }
    } else {
        tracing::debug!("modern capture unsupported; using legacy");
    }
    deadline.ensure_remaining()?;
    capture_legacy(subject, deadline)
        .map_err(|legacy_error| attach_modern_failure(legacy_error, modern_failure.as_ref()))
}

/// Names the Modern attempt in the error the caller actually receives.
///
/// When Legacy succeeds the Modern failure is a routing detail and belongs in
/// the debug log only. When both fail, reporting Legacy's error alone
/// describes the fallback and hides the first refusal - and the two rarely
/// fail for the same reason, so an operator handed only the second one is
/// told the less useful half of what went wrong.
fn attach_modern_failure(
    legacy_error: AdapterError,
    modern_failure: Option<&AdapterError>,
) -> AdapterError {
    let Some(modern_error) = modern_failure else {
        return legacy_error;
    };
    let detail = match &legacy_error.platform_detail {
        Some(existing) => format!("{existing}; modern capture first failed: {modern_error}"),
        None => format!("modern capture first failed: {modern_error}"),
    };
    legacy_error.with_platform_detail(detail)
}

fn modern_deadline_slice(deadline: Deadline) -> Deadline {
    #[cfg(test)]
    if test_hooks::disable_deadline_slice() {
        return deadline;
    }
    let remaining = deadline.remaining();
    if remaining <= LEGACY_DEADLINE_FLOOR {
        return deadline.capped(Duration::ZERO);
    }
    deadline.capped(remaining - LEGACY_DEADLINE_FLOOR)
}

#[cfg(test)]
fn burn_deadline(deadline: Deadline) {
    while !deadline.is_expired() {
        let Ok(slice) = deadline.remaining_slice(Duration::from_millis(5)) else {
            break;
        };
        if slice.is_zero() {
            break;
        }
        std::thread::sleep(slice);
    }
}

#[cfg(test)]
pub(crate) mod test_hooks {
    use std::cell::Cell;

    thread_local! {
        static FORCE_UNSUPPORTED: Cell<bool> = const { Cell::new(false) };
        static FORCE_FAIL_AFTER_AVAILABLE: Cell<bool> = const { Cell::new(false) };
        static CONSUME_MODERN_SLICE: Cell<bool> = const { Cell::new(false) };
        static DISABLE_DEADLINE_SLICE: Cell<bool> = const { Cell::new(false) };
    }

    pub(crate) fn force_unsupported() -> bool {
        FORCE_UNSUPPORTED.with(Cell::get)
    }

    pub(crate) fn force_fail_after_available() -> bool {
        FORCE_FAIL_AFTER_AVAILABLE.with(Cell::get)
    }

    pub(crate) fn consume_modern_slice() -> bool {
        CONSUME_MODERN_SLICE.with(Cell::get)
    }

    pub(crate) fn disable_deadline_slice() -> bool {
        DISABLE_DEADLINE_SLICE.with(Cell::get)
    }

    pub(crate) fn with_force_unsupported<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&FORCE_UNSUPPORTED, true, run)
    }

    pub(crate) fn with_force_fail_after_available<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&FORCE_FAIL_AFTER_AVAILABLE, true, run)
    }

    pub(crate) fn with_consume_modern_slice<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&CONSUME_MODERN_SLICE, true, run)
    }

    pub(crate) fn with_disable_deadline_slice<R>(run: impl FnOnce() -> R) -> R {
        crate::system::fixture::test_support::with_flag(&DISABLE_DEADLINE_SLICE, true, run)
    }
}

#[cfg(test)]
#[path = "capture_backend_tests.rs"]
mod tests;
