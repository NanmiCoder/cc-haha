use agent_desktop_core::{AdapterError, Deadline, InteractionLease, PlatformAdapter};

pub(crate) const DEFAULT_FFI_TIMEOUT_MS: u64 = 5_000;

pub(crate) fn deadline() -> Result<Deadline, AdapterError> {
    Deadline::after(DEFAULT_FFI_TIMEOUT_MS)
}

pub(crate) fn lease(adapter: &dyn PlatformAdapter) -> Result<InteractionLease, AdapterError> {
    let deadline = deadline()?;
    #[cfg(unix)]
    if let Some(raw_fd) = inherited_lease_fd()? {
        return agent_desktop_core::adopt_inherited_unix_interaction_lease(raw_fd, deadline);
    }
    adapter.acquire_interaction_lease(deadline)
}

#[cfg(unix)]
fn inherited_lease_fd() -> Result<Option<std::os::fd::RawFd>, AdapterError> {
    let Some(value) = std::env::var_os(agent_desktop_core::INTERACTION_LEASE_FD_ENV) else {
        return Ok(None);
    };
    let value = value.into_string().map_err(|_| {
        AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "Inherited interaction lease FD is not valid UTF-8",
        )
    })?;
    let raw_fd = value.parse::<std::os::fd::RawFd>().map_err(|_| {
        AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "Inherited interaction lease FD must be a nonnegative decimal integer",
        )
    })?;
    if raw_fd < 0 {
        return Err(AdapterError::new(
            agent_desktop_core::ErrorCode::InvalidArgs,
            "Inherited interaction lease FD must be nonnegative",
        ));
    }
    Ok(Some(raw_fd))
}

macro_rules! operation_deadline {
    () => {{
        match $crate::operation::deadline() {
            Ok(deadline) => deadline,
            Err(error) => {
                $crate::error::set_last_error(&error);
                return $crate::error::last_error_code();
            }
        }
    }};
}

macro_rules! interaction_lease {
    ($adapter:expr) => {{
        match $crate::operation::lease($adapter) {
            Ok(lease) => lease,
            Err(error) => {
                $crate::error::set_last_error(&error);
                return $crate::error::last_error_code();
            }
        }
    }};
}

pub(crate) use interaction_lease;
pub(crate) use operation_deadline;
