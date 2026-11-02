use std::fs;
use std::io;
use std::os::fd::BorrowedFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

use agent_desktop_core::INTERACTION_LEASE_FD_ENV;
use rustix::io::{FdFlags, fcntl_getfd, fcntl_setfd};

use super::owner_entry::{
    BUILD_IDENTITY_ENV, DISPLAY_ENV, MARKER_ENV, NONCE_ENV, PAYLOAD_FD_ENV, build_identity,
};
use crate::input::clipboard::payload::GENERATION;

const INHERITED_FROM_PARENT: [&str; 5] = [
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "AGENT_DESKTOP_HOME",
    "HOME",
];
const LOWEST_INHERITED_FD: i32 = 3;

fn share_with_child(payload_fd: i32) -> io::Result<()> {
    let descriptor = unsafe { BorrowedFd::borrow_raw(payload_fd) };
    fcntl_setfd(descriptor, FdFlags::empty()).map_err(io::Error::from)
}

/// What the owner is started with: the located helper, null stdio and an
/// environment that is an allowlist. The display is the one the setter
/// resolved, never the owner's own lookup, and the lease variable is not on
/// the list. The payload descriptor stays close-on-exec in this process and
/// loses the flag only in the forked child, right before it executes the
/// helper, so no other child of the host can inherit it.
pub(crate) fn build_command(
    helper: &Path,
    display: &str,
    nonce: &str,
    payload_fd: i32,
    parent_env: &dyn Fn(&str) -> Option<String>,
) -> Command {
    let mut command = Command::new(helper);
    command.env_clear().envs(
        INHERITED_FROM_PARENT
            .into_iter()
            .filter_map(|name| parent_env(name).map(|value| (name, value))),
    );
    let own = [
        ("DISPLAY", display.to_owned()),
        (DISPLAY_ENV, display.to_owned()),
        (MARKER_ENV, GENERATION.to_string()),
        (BUILD_IDENTITY_ENV, build_identity()),
        (PAYLOAD_FD_ENV, payload_fd.to_string()),
        (NONCE_ENV, nonce.to_owned()),
    ];
    command
        .envs(own)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || share_with_child(payload_fd));
    }
    command
}

/// Makes the lease descriptor a parent passed down close-on-exec again, so
/// the owner never holds the interaction lock. Only a number above the
/// standard streams that names an open descriptor is touched.
pub(crate) fn protect_lease_descriptor(parent_env: &dyn Fn(&str) -> Option<String>) -> bool {
    let Some(number) = parent_env(INTERACTION_LEASE_FD_ENV)
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|number| *number >= LOWEST_INHERITED_FD)
    else {
        return false;
    };
    if fs::metadata(format!("/proc/self/fd/{number}")).is_err() {
        return false;
    }
    let descriptor = unsafe { BorrowedFd::borrow_raw(number) };
    fcntl_getfd(descriptor)
        .and_then(|flags| fcntl_setfd(descriptor, flags | FdFlags::CLOEXEC))
        .is_ok()
}

#[cfg(test)]
#[path = "owner_spawn_spec_tests.rs"]
mod tests;
