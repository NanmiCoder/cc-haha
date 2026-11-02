use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Unscoped,
    Scoped,
}

fn is_bus_unavailable(error: &AdapterError) -> bool {
    error.code == ErrorCode::PlatformNotSupported && !error.permits_retry_by_default()
}

fn as_timeout(error: &AdapterError) -> AdapterError {
    let cause = error
        .platform_detail
        .clone()
        .unwrap_or_else(|| error.message.clone());
    AdapterError::timeout("The desktop could not be read in time")
        .with_platform_detail(format!("{:?}: {cause}", error.code))
}

/// Narrows every failure of a capture to the three codes core's poll loop
/// understands. A scoped target confirmed stopped stays `APP_UNRESPONSIVE`
/// and a missing accessibility bus stays fatal; everything else is
/// `TIMEOUT`, so one flaky read never aborts a wait or a batch. A fault that
/// arrived as `INTERNAL` also drops the cached connection so the next poll
/// reconnects.
pub(crate) fn narrow(
    error: AdapterError,
    scope: Scope,
    deadline: Deadline,
    forget: impl FnOnce(),
) -> AdapterError {
    if is_bus_unavailable(&error) {
        return error;
    }
    if error.code == ErrorCode::AppUnresponsive && scope == Scope::Scoped {
        return error;
    }
    if error.code == ErrorCode::Internal {
        forget();
    }
    if deadline.is_expired() {
        return deadline.timeout_error();
    }
    if error.code == ErrorCode::Timeout {
        return error;
    }
    as_timeout(&error)
}

#[cfg(test)]
#[path = "signal_boundary_tests.rs"]
mod tests;
