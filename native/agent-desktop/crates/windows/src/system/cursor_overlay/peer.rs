//! Who is on the other end of the control pipe.
//!
//! The pipe carries no security descriptor. This crate deliberately does not
//! author one — `private_file` records descriptor authoring
//! and DACL validation as deliberately absent, after an earlier attempt sank on `AceSize`
//! handling, and a test pins the ACL/ACE symbol family out of it. So the peer
//! is authenticated instead, with the token APIs the crate already calls.
//!
//! The check runs in both directions. A server that only checked its clients
//! would still be a server a local process could impersonate: the pipe's name
//! is a deterministic function of the state root and session id, so anything
//! that wins the creation race receives every control the session sends and
//! can return the acknowledgement byte — which would make `data.rendered`
//! report `true` while nothing is drawn.
//!
//! What this does not close is stated rather than implied: every agent host
//! here is single-user, so a same-user process running the real binary passes
//! both checks. The security-descriptor decision is taken against that known
//! gap, not against a closed hole.
//!
//! The two directions do not ask the same question. A client may legitimately
//! run under any image — an FFI host is one — so clients are authenticated by
//! user alone. A server may not: the renderer is only ever forked from this
//! tool's own binary, so the server's image is checked too.
//!
//! That server-side image check is against the file stem, so any same-user
//! `agent-desktop.exe` at any path passes it. Deliberate, and settled here so
//! the question is not re-filed. The only strengthening that is not theatre —
//! demanding the server's full image path equal the client's `current_exe()` —
//! breaks two things that are not misuse. A debug build legitimately reaches a
//! renderer a release build started, which is the ordinary shape of working on
//! this code; and under an FFI host `current_exe()` is the host process, so
//! the comparison could never pass at all. It also closes nothing: the
//! adversary it would exclude is a same-user process, and a same-user process
//! can simply run the genuine binary, which both draws and acknowledges. A
//! check that costs the development workflow and the FFI host while an
//! attacker steps around it by using the real thing is not a check.

#[cfg(target_os = "windows")]
pub(crate) use imp::{peer_is_this_user, server_is_this_user, terminate_pipe_server};

#[cfg(not(target_os = "windows"))]
pub(crate) fn peer_is_this_user(_pipe: isize) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn server_is_this_user(_pipe: isize) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_pipe_server(_pipe: isize) -> bool {
    false
}

#[cfg(target_os = "windows")]
mod imp {
    use crate::system::cursor_overlay::image_identity;
    use crate::system::runtime::token_sid::{SidBuffer, TokenSource, token_user_sid};
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Pipes::{
        GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE, QueryFullProcessImageNameW, TerminateProcess,
    };

    /// Closes on every path out of a check, including the ones that give up
    /// before asking anything of the process.
    struct OwnedProcess(HANDLE);

    impl Drop for OwnedProcess {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The client on this connection, resolved before its payload is read.
    ///
    /// `ImpersonateNamedPipeClient` is the obvious call and cannot serve
    /// here: it adopts the security context of the *last message read from
    /// the pipe*, so with nothing read there is no context to assume and it
    /// fails. Resolving the process id instead keeps the no-payload-read
    /// property the impersonation route only appeared to offer.
    pub(crate) fn peer_is_this_user(pipe: isize) -> bool {
        let mut process_id = 0u32;
        let ok = unsafe { GetNamedPipeClientProcessId(pipe as HANDLE, &mut process_id) };
        if ok == 0 {
            return false;
        }
        let Some(process) = open_for_inspection(process_id) else {
            return false;
        };
        runs_as_this_user(&process)
    }

    /// The server this client just connected to, checked before anything is
    /// written to it.
    ///
    /// Both facts are read from the one handle: the user who runs it, and the
    /// image it runs. A same-user process that is not this tool's binary can
    /// still win the deterministic pipe name, and answering its acknowledgement
    /// byte would report a frame that was never drawn.
    pub(crate) fn server_is_this_user(pipe: isize) -> bool {
        let mut process_id = 0u32;
        let ok = unsafe { GetNamedPipeServerProcessId(pipe as HANDLE, &mut process_id) };
        if ok == 0 {
            return false;
        }
        let Some(process) = open_for_inspection(process_id) else {
            return false;
        };
        runs_as_this_user(&process) && runs_our_image(&process)
    }

    /// Ends the process serving this pipe, when it is one of ours, and reports
    /// whether it did.
    ///
    /// This is not belt-and-braces behind a polite shutdown. A renderer on a
    /// generation this build no longer speaks exists precisely because the wire
    /// format changed, so it may be unable to decode the `Disable` that would
    /// have ended it politely — and what it leaves on screen is a topmost,
    /// click-through window with no taskbar entry that no control can address.
    /// Ending the process is what removes it: the OS destroys the layered
    /// window with its owner.
    ///
    /// Guarded by the same two questions a client asks of any server it found,
    /// asked once, of the single handle the terminate is issued on. Resolving
    /// the id twice would leave a window in which it could be reused by an
    /// unrelated process between the check and the kill. The caller reaches
    /// here only for a name it derived for this exact session and a generation
    /// it has retired, so nothing else is in range to begin with.
    pub(crate) fn terminate_pipe_server(pipe: isize) -> bool {
        let mut process_id = 0u32;
        let resolved = unsafe { GetNamedPipeServerProcessId(pipe as HANDLE, &mut process_id) };
        if resolved == 0 || process_id == unsafe { GetCurrentProcessId() } {
            return false;
        }
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                0,
                process_id,
            )
        };
        if handle.is_null() {
            return false;
        }
        let process = OwnedProcess(handle);
        if !runs_as_this_user(&process) || !runs_our_image(&process) {
            return false;
        }
        unsafe { TerminateProcess(process.0, 0) != 0 }
    }

    fn open_for_inspection(process_id: u32) -> Option<OwnedProcess> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            None
        } else {
            Some(OwnedProcess(process))
        }
    }

    fn runs_as_this_user(process: &OwnedProcess) -> bool {
        let Some(theirs) = user_sid_of(process) else {
            return false;
        };
        let Some(ours) = own_user_sid() else {
            return false;
        };
        ours.matches(&theirs)
    }

    fn runs_our_image(process: &OwnedProcess) -> bool {
        image_path_of(process).is_some_and(|path| image_identity::is_agent_desktop_image(&path))
    }

    /// A buffer sized for the longest path the API can answer with. A short
    /// buffer fails with `ERROR_INSUFFICIENT_BUFFER`, which reads here as "not
    /// our renderer" — so an install path longer than the guess would refuse
    /// every control and take the overlay out on that machine alone.
    const MAX_EXTENDED_PATH: usize = 32_768;

    /// Asked with no flags, so the answer is a Win32 path whose last component
    /// is a file name, rather than the `\Device\...` form.
    fn image_path_of(process: &OwnedProcess) -> Option<std::path::PathBuf> {
        let mut buffer = vec![0u16; MAX_EXTENDED_PATH];
        let mut size = buffer.len() as u32;
        let ok =
            unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut size) };
        if ok == 0 || size == 0 {
            return None;
        }
        Some(std::path::PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..size as usize],
        )))
    }

    fn own_user_sid() -> Option<SidBuffer> {
        token_user_sid(TokenSource::CurrentProcess).ok()
    }

    fn user_sid_of(process: &OwnedProcess) -> Option<SidBuffer> {
        let mut token: HANDLE = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) };
        if opened == 0 {
            return None;
        }
        let sid = token_user_sid(TokenSource::Handle(token)).ok();
        unsafe { CloseHandle(token) };
        sid
    }
}
