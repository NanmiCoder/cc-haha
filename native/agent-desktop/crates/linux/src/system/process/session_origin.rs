use std::path::Path;

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

use super::proc_stat;

const USER_MANAGER_PREFIX: &str = "user@";
const SERVICE_SUFFIX: &str = ".service";

/// The variable every launch gives the process it starts. It is the only
/// proof that the caller, and not the session, started a process: the parent
/// of an activated service and of a launched application is the same
/// reaper once the starter exits.
pub(crate) const LAUNCH_MARKER: &str = "AGENT_DESKTOP_LAUNCHED";

fn unknown() -> AdapterError {
    AdapterError::new(
        ErrorCode::ActionNotSupported,
        "The session process ownership could not be proven",
    )
    .with_disposition(DeliverySemantics::not_delivered())
    .with_suggestion(
        "Run inside the target desktop session with readable process and session-bus ownership.",
    )
}

/// The control group path of a process on the unified hierarchy.
pub(super) fn cgroup_of(pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::to_owned)
}

/// Whether the group is a service unit below the user's service manager, the
/// place a systemd user session puts the portals and the shell helpers it
/// starts. A scope, such as the one a launcher gives an application, is not.
pub(super) fn is_user_service_unit(group: &str) -> bool {
    let parts: Vec<&str> = group.split('/').filter(|part| !part.is_empty()).collect();
    let manager = parts
        .iter()
        .position(|part| part.starts_with(USER_MANAGER_PREFIX) && part.ends_with(SERVICE_SUFFIX));
    match (manager, parts.last()) {
        (Some(manager), Some(leaf)) => parts.len() > manager + 1 && leaf.ends_with(SERVICE_SUFFIX),
        _ => false,
    }
}

pub(crate) fn has_launch_marker(environment: &[u8]) -> bool {
    let wanted = format!("{LAUNCH_MARKER}=");
    environment
        .split(|byte| *byte == 0)
        .any(|entry| entry.starts_with(wanted.as_bytes()))
}

/// Whether a launch of this tool started the process. An environment that
/// cannot be read proves nothing and refuses.
pub(super) fn launched_by_agent(pid: u32) -> Result<bool, AdapterError> {
    std::fs::read(format!("/proc/{pid}/environ"))
        .map(|environment| has_launch_marker(&environment))
        .map_err(|_| unknown())
}

/// Whether the process runs as a user service unit of a group other than the
/// caller's own, which a caller that is itself a service would share.
pub(super) fn runs_as_service(pid: u32) -> Result<bool, AdapterError> {
    let group = cgroup_of(pid).ok_or_else(unknown)?;
    let own = cgroup_of(std::process::id()).ok_or_else(unknown)?;
    Ok(group != own && is_user_service_unit(&group))
}

/// Whether the parent of the process is the display owner, as a helper the
/// compositor spawned is.
pub(super) fn child_of_display_owner(
    pid: u32,
    is_display_owner: impl Fn(u32) -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    let parent = match proc_stat::read_stat(pid) {
        Ok(Some(stat)) => stat.parent,
        Ok(None) | Err(()) => return Err(unknown()),
    };
    if parent <= 1 || !Path::new(&format!("/proc/{parent}")).exists() {
        return Ok(false);
    }
    is_display_owner(parent)
}

/// Whether the process is the display owner or a child of it: the compositor
/// and the helpers it spawns are on its side of the session.
pub(super) fn on_display_owner_side(
    pid: u32,
    is_display_owner: impl Fn(u32) -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    Ok(is_display_owner(pid)? || child_of_display_owner(pid, &is_display_owner)?)
}

/// Whether an application that answers on the accessibility bus is really
/// part of the session: it owns a name on the session bus, runs as a user
/// service unit, or is on the display owner's side. An application the
/// caller launched, or one that has a window of its own, is never one. A
/// fact that cannot be read refuses.
pub(super) fn is_session_service(
    launched: impl FnOnce() -> Result<bool, AdapterError>,
    windowed: impl FnOnce() -> bool,
    service: impl FnOnce() -> Result<bool, AdapterError>,
    compositor_side: impl FnOnce() -> Result<bool, AdapterError>,
    named: impl FnOnce() -> Result<bool, AdapterError>,
) -> Result<bool, AdapterError> {
    if launched()? || windowed() {
        return Ok(false);
    }
    Ok(service()? || compositor_side()? || named()?)
}

#[cfg(test)]
#[path = "session_origin_tests.rs"]
mod tests;
