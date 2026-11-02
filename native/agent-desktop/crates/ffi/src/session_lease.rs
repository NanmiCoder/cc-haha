use agent_desktop_core::{AdapterError, AppError, session::SessionLivenessLease};

pub(crate) fn acquire(
    session_id: Option<&str>,
) -> Result<Option<SessionLivenessLease>, AdapterError> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    agent_desktop_core::session::acquire_liveness_lease(session_id).map_err(|error| match error {
        AppError::Adapter(error) => error,
        other => AdapterError::internal(other.to_string()),
    })
}
