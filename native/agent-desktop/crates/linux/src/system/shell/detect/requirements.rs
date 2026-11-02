use agent_desktop_core::{AdapterError, Deadline};

use super::service::is_shell_service;
use super::{
    CallFailure, Fact, NOTIFICATIONS, call, classify_daemon, daemon_fact_error, server_name,
    shell_owner, unreadable,
};
use crate::system::bus::session_bus::SessionBus as Bus;

pub(crate) fn require_daemon(deadline: Deadline) -> Result<(), AdapterError> {
    let connection = Bus::get(deadline)
        .map_err(|error| unreadable("notification service", &error.message, "daemon"))?;
    let (daemon, server) = classify_daemon(server_name(&connection, deadline));
    daemon_fact_error(&daemon, server.as_deref())?;
    let owner = call(
        deadline,
        crate::system::owner_process_id(&connection, NOTIFICATIONS),
    );
    let backend = call(deadline, shell_owner(&connection));
    check_owners(owner, backend, server.as_deref(), is_shell_service)
}

pub(super) fn check_owners(
    owner: Result<u32, CallFailure>,
    backend: Result<u32, CallFailure>,
    server: Option<&str>,
    is_shell_service: impl FnOnce(u32, u32) -> bool,
) -> Result<(), AdapterError> {
    match (owner, backend) {
        (Ok(owner), Ok(backend)) if owner == backend || is_shell_service(owner, backend) => Ok(()),
        (Ok(_), Ok(_) | Err(CallFailure::NoService)) => daemon_fact_error(
            &Fact::Absent("notification and shell service owners differ".to_owned()),
            server,
        ),
        (Err(error), _) | (_, Err(error)) => Err(unreadable(
            "notification service ownership",
            &format!("{error:?}"),
            "daemon",
        )),
    }
}
