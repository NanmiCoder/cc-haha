use std::fs;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::Command;

use agent_desktop_core::{
    AdapterError, ClipboardContent, DeliverySemantics, INTERACTION_LEASE_FD_ENV, InputOps,
};
use rustix::io::{FdFlags, fcntl_getfd, fcntl_setfd};

use super::support::*;
use crate::LinuxAdapter;
use crate::input::clipboard::owner::owner_record;

fn kill_by_pid(pid: u32) {
    let status = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "the test's own owner is killed by pid");
}

fn try_set(content: &ClipboardContent) -> Result<(), AdapterError> {
    LinuxAdapter::new()
        .set_clipboard_content(content, &lease())
        .map(|_| ())
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn a_record_left_by_a_killed_owner_is_replaced_and_never_signalled() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::Text("first".into()));
    let killed = the_record(&session.display);
    kill_by_pid(killed.pid);
    wait_until("the killed owner is gone", || gone(killed.pid));
    assert_eq!(records(&session.display).len(), 1, "the record is stale");
    set(&ClipboardContent::Text("second".into()));
    let current = the_record(&session.display);
    assert_ne!(current.pid, killed.pid);
    assert_eq!(
        foreign_read(&session.display, "UTF8_STRING").as_deref(),
        Some(b"second".as_slice())
    );
    kill_by_pid(current.pid);
    wait_until("the second owner is gone", || gone(current.pid));
    clear_and_finish();
    assert!(records(&session.display).is_empty());
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn the_interaction_lease_descriptor_is_not_inherited_by_the_owner() {
    let session = private_session();
    install_helper_beside_the_image();
    let marker: PathBuf = PathBuf::from(std::env::var("XDG_RUNTIME_DIR").expect("private runtime"))
        .join("lease-descriptor-marker");
    let file = fs::File::create(&marker).expect("a marker file");
    let number = file.as_raw_fd();
    fcntl_setfd(&file, FdFlags::empty()).expect("the descriptor is made inheritable");
    unsafe { std::env::set_var(INTERACTION_LEASE_FD_ENV, number.to_string()) };
    let outcome = try_set(&ClipboardContent::Text("leased".into()));
    unsafe { std::env::remove_var(INTERACTION_LEASE_FD_ENV) };
    let closed_on_exec = fcntl_getfd(&file)
        .expect("flags")
        .contains(FdFlags::CLOEXEC);
    outcome.expect("the clipboard is set");
    let owner = the_record(&session.display);
    let held: Vec<PathBuf> = fs::read_dir(format!("/proc/{}/fd", owner.pid))
        .expect("the owner's descriptors")
        .filter_map(|entry| fs::read_link(entry.ok()?.path()).ok())
        .collect();
    assert!(
        !held.contains(&marker),
        "the owner holds the lease descriptor: {held:?}"
    );
    assert!(
        closed_on_exec,
        "the parent made the descriptor close-on-exec"
    );
    clear_and_finish();
    let _ = fs::remove_file(&marker);
}

#[test]
#[ignore = "needs a private X11 session and the built clipboard owner"]
fn a_state_directory_the_owner_cannot_use_leaves_the_earlier_clipboard_untouched() {
    let session = private_session();
    install_helper_beside_the_image();
    set(&ClipboardContent::Text("before".into()));
    let earlier = the_record(&session.display);
    let dir = owner_record::record_dir().expect("a record directory");
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).expect("loosen the mode");
    let outcome = try_set(&ClipboardContent::Text("after".into()));
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("restore the mode");
    let error = outcome.expect_err("the owner cannot publish its record");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(
        foreign_read(&session.display, "UTF8_STRING").as_deref(),
        Some(b"before".as_slice()),
        "the earlier clipboard survives a helper that fails before it claims"
    );
    assert!(!gone(earlier.pid));
    clear_and_finish();
}
