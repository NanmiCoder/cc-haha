//! Live process/window identity builders shared by fixture and live test
//! modules across the crate.

use agent_desktop_core::{ProcessId, ProcessIdentity, WindowInfo, WindowState};

/// The identity a live pid actually carries right now: its process-instance
/// token, read fresh rather than assumed, so a test asserts against what the
/// OS reports instead of a value it fabricated.
pub(crate) fn live_process_identity(pid: ProcessId) -> ProcessIdentity {
    let token = crate::system::process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    ProcessIdentity::new(pid, token)
}

/// This test binary's own image file name, the name every fixture spawned
/// anywhere in it re-execs under and so the name a live test scopes its
/// `--app` resolution to.
pub(crate) fn own_image_name() -> String {
    std::env::current_exe()
        .expect("this test binary has a resolvable path")
        .file_name()
        .expect("the executable path carries a file name")
        .to_string_lossy()
        .into_owned()
}

/// A `WindowInfo` naming this test process itself as the window's owner -
/// the shape every fixture window built against the test's own process
/// needs, with a live-read token and image name rather than placeholders.
pub(crate) fn window_info_for_current_process(handle: isize) -> WindowInfo {
    let pid = ProcessId::from(std::process::id());
    let token = crate::system::process_identity::token_for_pid(pid)
        .expect("token read")
        .expect("live token");
    let app = crate::system::process_identity::process_image_name(pid).unwrap_or_default();
    WindowInfo {
        id: format!("w-{}", handle as usize),
        title: String::new(),
        app,
        pid,
        process_instance: Some(token),
        bounds: None,
        state: WindowState::default(),
    }
}
