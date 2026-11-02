use crate::system::process::identity::Identity;
use crate::system::x11::control::control_error::ControlError;

pub(in crate::system::x11) fn with_owner<G, T>(
    target: &agent_desktop_core::ProcessIdentity,
    grab: impl FnOnce() -> Result<G, ControlError>,
    owner: impl FnOnce() -> Option<u32>,
    identity: impl FnOnce(u32, &str) -> Identity,
    operation: impl FnOnce() -> Result<T, ControlError>,
) -> Result<T, ControlError> {
    let _grab = grab()?;
    if owner() != Some(target.pid.get())
        || identity(target.pid.get(), &target.instance) != Identity::Same
    {
        return Err(ControlError::StaleWindow);
    }
    operation()
}

#[cfg(test)]
#[path = "control_owner_tests.rs"]
mod tests;
