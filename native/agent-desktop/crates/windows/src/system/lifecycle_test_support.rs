//! Shared spawn-and-poll scaffolding for tests that need a real, windowless
//! child process with a readable creation-time token - `close_tests.rs` and
//! `lifecycle_envelope_parity_tests.rs` each grew their own copy of this.

#![cfg(all(test, target_os = "windows"))]

use agent_desktop_core::ProcessId;

use crate::system::process_identity;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Closes on every path out of a test, including a failed assertion -
/// without this a windowless child spawned mid-suite outlives the test that
/// spawned it.
pub(crate) struct KillOnDrop(pub(crate) std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Spawns a real, windowless child (`ping`, so it outlives the polling below)
/// and waits for its process-generation token to become readable - creation
/// and the token becoming readable are not atomic, so a caller that read
/// immediately would sometimes see `Ok(None)`.
pub(crate) fn spawn_windowless_child() -> (KillOnDrop, ProcessId, String) {
    use std::os::windows::process::CommandExt;

    let child = std::process::Command::new("cmd")
        .args(["/C", "ping", "-n", "60", "127.0.0.1", ">", "NUL"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("windowless child");
    let pid = ProcessId::from(child.id());
    let started = std::time::Instant::now();
    let token = loop {
        if let Ok(Some(token)) = process_identity::token_for_pid(pid) {
            break token;
        }
        if started.elapsed() > std::time::Duration::from_secs(5) {
            panic!("windowless child never exposed a creation-time token");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    (KillOnDrop(child), pid, token)
}
