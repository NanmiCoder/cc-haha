use agent_desktop_core::{AdapterError, Deadline};

mod action;
mod close;
mod dismiss;
mod dismiss_all;
mod extract;
mod list;
mod session;
mod signal;
mod target;
mod verify;
mod world;

#[cfg(test)]
mod fake;

#[cfg(test)]
mod backend_live_tests;
#[cfg(test)]
mod live_tests;

pub(crate) use action::action;
pub(crate) use dismiss::dismiss;
pub(crate) use dismiss_all::dismiss_all;
pub(crate) use list::list;

pub(crate) fn check_support(deadline: Deadline) -> Result<(), AdapterError> {
    crate::system::shell::detect::require_daemon(deadline)
}
