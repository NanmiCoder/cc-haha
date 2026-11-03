//! Removing a renderer left drawing by a generation this build cannot address.
//!
//! The control pipe's name hashes the protocol generation, so a renderer from
//! an earlier generation is not merely out of date — it is unreachable. Its
//! window is topmost, click-through and absent from the taskbar, and every
//! control this build sends routes past it to a name it does not serve. The
//! session-manifest watch does not help either: the session has not ended.
//! Without this pass nothing in the product can take that window off screen.
//!
//! Which generations are stale is not guessed from the running processes.
//! Reading another process's command line means walking its PEB, a COM query
//! or a shell out — hundreds of milliseconds and a great deal of unsafe code,
//! on a path that runs before every overlay is enabled. The ledger already
//! knows the answer, and a pipe name is a pure function of it.

use std::path::Path;
use std::time::Duration;

use agent_desktop_core::CursorOverlayControl;

use super::pipe_name;
use super::transport::{self, ReachOutcome};

/// Short on purpose. The sweep runs on the enable path ahead of the reach that
/// decides `data.rendered`, so whatever it spends is spent by every enable. A
/// renderer that is going to answer answers in milliseconds; one that has not
/// answered inside this is one the terminate exists for.
const RETIREMENT_BUDGET: Duration = Duration::from_millis(300);

/// Clears every renderer this build can no longer address, for this session.
///
/// Silent by design. A session with no stale renderer is the ordinary case,
/// and a sweep that failed must not turn a working enable into an error — the
/// overlay is fail-soft, and the caller asked to draw, not to tidy up.
pub(crate) fn sweep(root: &Path, session_id: &str) {
    for name in retirement_targets(root, session_id, &pipe_name::PROTOCOL_GENERATIONS) {
        retire(&name, session_id);
    }
}

/// The pipe names a sweep must clear: one per retired generation, and never
/// the one this build is about to use. Pure, so what the sweep aims at can be
/// asserted without a renderer to aim at.
fn retirement_targets(root: &Path, session_id: &str, ledger: &[&'static str]) -> Vec<String> {
    pipe_name::retired_generations(ledger)
        .iter()
        .map(|generation| pipe_name::pipe_name_for_generation(root, session_id, None, generation))
        .collect()
}

/// Politely first. A stale renderer that can still decode a `Disable` takes
/// itself down and its acknowledgement says so; only one that answers nothing
/// usable inside the budget is ended by force.
///
/// `NoRenderer` means the name is not served at all, so there is no server to
/// resolve and nothing to end.
fn retire(name: &str, session_id: &str) {
    let disable = CursorOverlayControl::disable(session_id.to_owned());
    match transport::reach(name, &disable, RETIREMENT_BUDGET) {
        ReachOutcome::Delivered | ReachOutcome::NoRenderer => {}
        ReachOutcome::Unreachable(_) => terminate_server_of(name),
    }
}

#[cfg(target_os = "windows")]
fn terminate_server_of(name: &str) {
    imp::terminate_server_of(name);
}

#[cfg(not(target_os = "windows"))]
fn terminate_server_of(_name: &str) {}

#[cfg(target_os = "windows")]
mod imp {
    use super::RETIREMENT_BUDGET;
    use crate::system::cursor_overlay::peer;
    use crate::system::cursor_overlay::wide::wide;
    use std::time::Instant;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_PIPE_BUSY, GENERIC_READ, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Opens the pipe only to learn who serves it, so read access is enough:
    /// nothing is written down a connection whose server is about to end.
    pub(super) fn terminate_server_of(name: &str) {
        let Some(handle) = connect(name) else {
            return;
        };
        peer::terminate_pipe_server(handle.0 as isize);
    }

    /// Every instance being busy still means a server is there, which is the
    /// case worth waiting a moment for. The wait is never handed zero:
    /// `WaitNamedPipeW` reads zero as "use the server's own default wait",
    /// which would park past this deadline rather than inside it.
    fn connect(name: &str) -> Option<OwnedHandle> {
        let wide_name = wide(name);
        let deadline = Instant::now() + RETIREMENT_BUDGET;
        loop {
            let handle = unsafe {
                CreateFileW(
                    wide_name.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Some(OwnedHandle(handle));
            }
            if unsafe { GetLastError() } != ERROR_PIPE_BUSY {
                return None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let wait = remaining.as_millis().clamp(1, 1000) as u32;
            unsafe { WaitNamedPipeW(wide_name.as_ptr(), wait) };
        }
    }
}

#[cfg(test)]
#[path = "retire_tests.rs"]
mod tests;
