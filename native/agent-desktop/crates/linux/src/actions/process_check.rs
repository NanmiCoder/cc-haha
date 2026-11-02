use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, ErrorCode, ProcessIdentity};

use crate::system::process::process_lookup::Lookup;
use crate::system::{SharedBus, owner_process_id, process::process_facts, within};
use crate::tree::AtspiElement;
use crate::tree::properties::absence::failure;
use crate::tree::properties::failure::Failure;

fn stale(message: &'static str) -> AdapterError {
    AdapterError::stale_ref_because(message)
}

fn identity_unread() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionFailed,
        "The process of the target could not be identified, so nothing was written",
    )
    .with_suggestion("Retry the action; the process table could not be read this time.")
    .with_disposition(DeliverySemantics::not_delivered())
}

pub(crate) fn judge_frame(
    expected: &ProcessIdentity,
    frame_pid: u32,
    live: &Lookup,
) -> Result<(), AdapterError> {
    if frame_pid != expected.pid.get() {
        return Err(stale("The element belongs to a different process"));
    }
    match live {
        Lookup::Gone => Err(stale("The application of the element has exited")),
        Lookup::Unreadable => Err(identity_unread()),
        Lookup::Found(facts) if facts.instance == expected.instance => Ok(()),
        Lookup::Found(_) => Err(stale("The application of the element was restarted")),
    }
}

pub(crate) fn judge_owner(
    target_pid: u32,
    owner: Result<u32, Option<zbus::Error>>,
) -> Result<(), AdapterError> {
    match owner {
        Ok(pid) if pid == target_pid => Ok(()),
        Ok(_) => Err(stale(
            "The bus name of the element now belongs to another process",
        )),
        Err(None) => Err(stale("The application of the element has left the bus")),
        Err(Some(error)) => match failure(&error) {
            Failure::AppGone => Err(stale("The application of the element has left the bus")),
            Failure::TimedOut => Err(AdapterError::timeout(
                "The bus did not name the owner of the element in time",
            )
            .with_disposition(DeliverySemantics::not_delivered())),
            Failure::Suspect | Failure::Other => Err(identity_unread()),
        },
    }
}

pub(crate) fn verify_process(
    bus: &SharedBus,
    element: &AtspiElement,
    expected: Option<&ProcessIdentity>,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let frame_pid = element.frame().map_or(element.pid(), AtspiElement::pid);
    judge_frame(
        expected,
        frame_pid,
        &process_facts::lookup(expected.pid.get()),
    )?;
    let connection = bus.get(deadline)?;
    let owner = within(deadline, async {
        Ok(owner_process_id(connection.inner(), element.bus_name())
            .await
            .map_err(Some))
    })?;
    judge_owner(element.pid(), owner)
}

#[cfg(test)]
#[path = "process_check_tests.rs"]
mod tests;
