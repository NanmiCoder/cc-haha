//! Every endpoint a session is currently answering on.
//!
//! A `Disable` names no agent, on purpose: stopping a session stops all of it,
//! however many agents drew inside it. Nothing here is told which agents exist
//! — their ids belong to whoever started them — so the session's endpoints are
//! found rather than derived, by listing the pipes the OS is serving and
//! keeping the ones whose names begin with this session's segment.
//!
//! The reference does the same thing against its socket directory. A named
//! pipe has no directory entry, but the object namespace is enumerable through
//! the same directory-listing call as a filesystem, which is why the pipe name
//! puts the session segment first: the prefix is what makes the listing
//! answerable.

#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::pipe_name;
#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::wide::wide;
#[cfg(target_os = "windows")]
use std::path::Path;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW,
};

/// The pipe device's own directory, which lists every named pipe on the
/// machine. It is not a filesystem path and cannot be joined with one.
#[cfg(target_os = "windows")]
const PIPE_DIRECTORY: &str = r"\\.\pipe\*";

/// The names this session is answering on right now, including the one it
/// answers on when no agent was named.
///
/// Returning an empty list is not evidence that a session has no renderer:
/// an enumeration that fails answers the same way. The caller uses this to
/// widen a teardown, never to conclude one is unnecessary, so a failed
/// listing costs a broadcast its extra recipients rather than reporting a
/// session already stopped.
#[cfg(target_os = "windows")]
pub(crate) fn session_endpoints(root: &Path, session_id: &str) -> Vec<String> {
    let prefix = pipe_name::session_prefix(root, session_id);
    let mut found = vec![pipe_name::pipe_name(root, session_id, None)];
    for name in list_pipes() {
        if name.starts_with(&prefix) {
            found.push(format!(r"\\.\pipe\{name}"));
        }
    }
    found.sort();
    found.dedup();
    found
}

#[cfg(target_os = "windows")]
struct Listing(HANDLE);

#[cfg(target_os = "windows")]
impl Drop for Listing {
    fn drop(&mut self) {
        unsafe { FindClose(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn list_pipes() -> Vec<String> {
    let pattern = wide(PIPE_DIRECTORY);
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(pattern.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let listing = Listing(handle);
    let mut names = Vec::new();
    loop {
        names.push(file_name_of(&data));
        if unsafe { FindNextFileW(listing.0, &mut data) } == 0 {
            break;
        }
    }
    names
}

/// The entry's name, cut at its terminator. `cFileName` is a fixed-width
/// buffer whose tail is whatever the previous entry left there, so reading
/// the whole array appends the remains of a longer neighbour's name.
#[cfg(target_os = "windows")]
fn file_name_of(data: &WIN32_FIND_DATAW) -> String {
    crate::system::process_identity::wide_buffer_to_string(&data.cFileName)
}

#[cfg(all(test, target_os = "windows"))]
#[path = "discover_tests.rs"]
mod tests;
