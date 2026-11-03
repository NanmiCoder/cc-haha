use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionPolicy, SnapshotSurface, WindowInfo,
};

use crate::system::shell::shell_surface::resolve_surface;
use crate::system::shell::shell_surface_open::{close_surface, open_surface};

const CLEANUP_TIMEOUT_MS: u64 = 2_000;

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

/// Opens and closes the Action Center around exactly one call.
///
/// A center that is already presented on entry is adopted, never raised, and
/// is left presented on exit; a center this session raised itself is dismissed
/// on exit. The teardown runs on every path out of the wrapped call - return,
/// error, and drop after a panic in the caller's own bookkeeping - so a raised
/// center is never leaked behind a failed read. The session carries no
/// lifecycle beyond its one call: every call that needs the surface opens its
/// own session, so a poll loop opens and closes per poll.
pub(crate) struct ActionCenterSession {
    hwnd: isize,
    close_pending: bool,
    cleanup_on_drop: bool,
}

impl ActionCenterSession {
    pub(crate) fn open(
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Self, AdapterError> {
        if let Some(surface) = resolve_surface(SnapshotSurface::ActionCenter, deadline)? {
            return Ok(Self {
                hwnd: hwnd_of(&surface)?,
                close_pending: false,
                cleanup_on_drop: true,
            });
        }
        if !policy.is_headed() {
            return Err(closed_center_policy_error(policy));
        }
        Self::raise(policy, deadline)
    }

    pub(crate) fn hwnd(&self) -> isize {
        self.hwnd
    }

    pub(crate) fn close(mut self) -> Result<(), AdapterError> {
        let result = self.cleanup();
        self.cleanup_on_drop = false;
        result
    }

    fn raise(policy: InteractionPolicy, deadline: Deadline) -> Result<Self, AdapterError> {
        match open_surface(SnapshotSurface::ActionCenter, policy, deadline) {
            Ok(surface) => Ok(Self {
                hwnd: hwnd_of(&surface)?,
                close_pending: true,
                cleanup_on_drop: true,
            }),
            Err(error) => {
                let cleanup = close_surface(SnapshotSurface::ActionCenter, cleanup_deadline()?);
                merge_session_result(Err(error), cleanup)
            }
        }
    }

    fn cleanup(&mut self) -> Result<(), AdapterError> {
        if !self.close_pending {
            return Ok(());
        }
        let result = close_surface(SnapshotSurface::ActionCenter, cleanup_deadline()?);
        if result.is_ok() {
            self.close_pending = false;
        }
        result
    }
}

impl Drop for ActionCenterSession {
    fn drop(&mut self) {
        if !self.cleanup_on_drop {
            return;
        }
        if let Err(error) = self.cleanup() {
            tracing::warn!(%error, "Action Center cleanup failed in Drop");
        }
    }
}

pub(super) fn close_session<T>(
    session: ActionCenterSession,
    result: Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    merge_session_result(result, session.close())
}

pub(super) fn merge_session_result<T>(
    result: Result<T, AdapterError>,
    cleanup: Result<(), AdapterError>,
) -> Result<T, AdapterError> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(close_err)) => Err(close_err),
        (Err(err), Ok(())) => Err(err),
        (Err(err), Err(close_err)) => {
            tracing::warn!(error = %close_err, "Action Center cleanup also failed after the operation failed");
            Err(err)
        }
    }
}

fn cleanup_deadline() -> Result<Deadline, AdapterError> {
    Deadline::detached_after(CLEANUP_TIMEOUT_MS)
}

fn hwnd_of(surface: &WindowInfo) -> Result<isize, AdapterError> {
    surface
        .id
        .strip_prefix("w-")
        .and_then(|number| number.parse::<isize>().ok())
        .filter(|handle| *handle > 0)
        .ok_or_else(|| {
            AdapterError::new(ErrorCode::InvalidArgs, "Malformed shell surface identifier")
        })
}

pub(super) fn closed_center_policy_error(policy: InteractionPolicy) -> AdapterError {
    AdapterError::policy_denied_for_policy(
        "The Action Center is closed and observation cannot open it in headless mode",
        policy,
    )
    .with_suggestion(
        "Open the Action Center yourself or pass --headed to allow opening and restoring desktop focus.",
    )
}
