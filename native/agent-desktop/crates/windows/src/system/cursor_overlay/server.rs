//! The renderer's end of the control pipe.
//!
//! `FILE_FLAG_FIRST_PIPE_INSTANCE` is the singleton lock: a second child
//! fails to claim the name and withdraws, which is why claiming happens
//! before any window exists. `PIPE_REJECT_REMOTE_CLIENTS` keeps the channel
//! local, and every accepted connection is checked against this user before
//! its payload is read.
//!
//! Accepting happens on a worker thread, and the reason is that
//! `ConnectNamedPipe` on a synchronous pipe does not return until a client
//! arrives. A main loop calling it directly could never notice anything else
//! — not a window message, not the end of its own session — so its idle
//! branch would exist without ever being reachable. The worker blocks; the
//! thread that owns the window stays free to tick.
//!
//! Acknowledging and disconnecting stay on the main thread, after the frame
//! has been drawn. A worker that acknowledged would race the process exit a
//! `Disable` triggers, and a teardown that had in fact succeeded would report
//! a broken pipe to the caller waiting on it.

#[cfg(target_os = "windows")]
use super::parked_flush::ParkedFlush;
#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::wide::{wide, win32_error};
#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::{framing, peer};
#[cfg(target_os = "windows")]
use agent_desktop_core::{AdapterError, CursorOverlayControl};
use std::sync::Arc;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_PIPE_CONNECTED, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_FIRST_PIPE_INSTANCE, FlushFileBuffers, PIPE_ACCESS_DUPLEX, ReadFile, WriteFile,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PeekNamedPipe,
};

#[cfg(target_os = "windows")]
const POLL: Duration = Duration::from_millis(8);

/// How long a connected client is given to put its control on the wire
/// before the connection is abandoned. A client that connects and writes
/// nothing died mid-call; it is not a reason to stop serving.
#[cfg(target_os = "windows")]
const PAYLOAD_WAIT: Duration = Duration::from_millis(250);

/// How long the renderer will wait for a client to take its
/// acknowledgement before carrying on without it.
#[cfg(target_os = "windows")]
const ACKNOWLEDGEMENT_BUDGET: Duration = Duration::from_millis(250);

#[cfg(target_os = "windows")]
pub(crate) enum ClaimError {
    /// Another renderer already serves this session. Withdrawing here,
    /// before a window exists, is what keeps a duplicate from drawing.
    AlreadyServed,
    Failed(AdapterError),
}

#[cfg(target_os = "windows")]
pub(crate) enum Accepted {
    Control(Box<CursorOverlayControl>),
    /// Nothing arrived within the tick.
    Idle,
    Broken(AdapterError),
}

/// The pipe handle as it crosses to the accept thread. Only the blocking
/// connect and the read use it there; ownership and closing stay with the
/// `Listener`.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct SharedHandle(isize);

#[cfg(target_os = "windows")]
unsafe impl Send for SharedHandle {}

#[cfg(target_os = "windows")]
impl SharedHandle {
    fn get(self) -> HANDLE {
        self.0 as HANDLE
    }
}

/// Owns the pipe for the life of the renderer, and deliberately has no
/// `Drop`.
///
/// The accept thread is parked inside a blocking `ConnectNamedPipe` on
/// this handle, and closing a handle another thread is waiting on does
/// not wake that thread — it hangs the closer. A renderer that did close
/// it stopped clearing its overlay and never exited, which only stayed
/// hidden while an earlier design ended the process without running any
/// destructor. The listener lives exactly as long as the process, and
/// every way out of the serve loop ends that process, so letting teardown
/// reclaim the handle is both correct and the only thing that terminates.
#[cfg(target_os = "windows")]
pub(crate) struct Listener {
    handle: HANDLE,
    arrivals: Receiver<CursorOverlayControl>,
    release: SyncSender<()>,
    waiting: Arc<AtomicBool>,
}

#[cfg(target_os = "windows")]
impl Listener {
    pub(crate) fn claim(name: &str) -> Result<Self, ClaimError> {
        let wide_name = wide(name);
        let handle = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                framing::MAX_CONTROL_BYTES as u32,
                framing::MAX_CONTROL_BYTES as u32,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let code = unsafe { GetLastError() };
            if code == ERROR_ACCESS_DENIED {
                return Err(ClaimError::AlreadyServed);
            }
            return Err(ClaimError::Failed(win32_error(
                "The cursor overlay pipe could not be created",
            )));
        }

        let (arrival_tx, arrivals) = sync_channel::<CursorOverlayControl>(0);
        let (release, release_rx) = sync_channel::<()>(0);
        let shared = SharedHandle(handle as isize);
        let waiting = Arc::new(AtomicBool::new(false));
        let accepted = Arc::clone(&waiting);
        std::thread::spawn(move || accept_loop(shared, &arrival_tx, &release_rx, &accepted));

        Ok(Self {
            handle,
            arrivals,
            release,
            waiting,
        })
    }

    /// Waits up to `tick` for the worker to hand over a control. An
    /// `Idle` return is a real tick of quiet, which is what lets the
    /// caller pump its window and re-read its session.
    pub(crate) fn next_control(&self, tick: Duration) -> Accepted {
        match self.arrivals.recv_timeout(tick) {
            Ok(control) => {
                self.waiting.store(false, Ordering::Release);
                Accepted::Control(Box::new(control))
            }
            Err(RecvTimeoutError::Timeout) => Accepted::Idle,
            Err(RecvTimeoutError::Disconnected) => Accepted::Broken(AdapterError::internal(
                "The cursor overlay stopped accepting controls",
            )),
        }
    }

    /// Writes the acknowledgement and waits for the client to take it.
    ///
    /// The flush is not tidiness. Disconnecting discards whatever the
    /// client has not read, and the one control that acknowledges and
    /// then immediately tears down is `Disable` - so without this, the
    /// caller waiting on a teardown that did succeed would see a broken
    /// pipe. The waiting is bounded, for the reason the helper gives.
    pub(crate) fn acknowledge(&self) {
        let byte = [framing::ACKNOWLEDGEMENT];
        let mut written = 0u32;
        unsafe {
            WriteFile(
                self.handle,
                byte.as_ptr(),
                1,
                &mut written,
                std::ptr::null_mut(),
            );
        }
        self.wait_for_the_client_to_read();
    }

    /// Waits for the acknowledgement to be taken, but never past the
    /// budget.
    ///
    /// `FlushFileBuffers` on a pipe server returns only once the client
    /// has read everything, and it takes no timeout — so calling it on
    /// this thread hands a client the ability to park the renderer
    /// forever simply by not reading. A suspended parent is enough: a
    /// debugger break, a harness that suspends its children. Parked here,
    /// the window is never pumped, no further control is ever accepted,
    /// and the session watch never runs — which produces exactly the
    /// thing this module exists to prevent, a topmost click-through
    /// window with no console, no taskbar entry and no Alt-Tab presence
    /// that nothing in the product can remove.
    ///
    /// So the wait happens on a thread that is allowed to be abandoned.
    /// Giving up costs only the acknowledgement, which the client is
    /// already prepared to time out on.
    fn wait_for_the_client_to_read(&self) {
        let Some(parked) = ParkedFlush::claim() else {
            return;
        };
        let shared = SharedHandle(self.handle as isize);
        let (done, taken) = sync_channel::<()>(1);
        std::thread::spawn(move || {
            let _parked = parked;
            unsafe { FlushFileBuffers(shared.get()) };
            let _ = done.send(());
        });
        let _ = taken.recv_timeout(ACKNOWLEDGEMENT_BUDGET);
    }

    /// Releases the connection and lets the worker wait for the next
    /// client. Without the disconnect the pipe stays bound to a departed
    /// client and no second control is ever accepted.
    pub(crate) fn finish(&self) {
        unsafe { DisconnectNamedPipe(self.handle) };
        let _ = self.release.send(());
    }

    /// Whether a control has already been read off the wire and is
    /// waiting to be served.
    ///
    /// What it exists for is the animation that plays after a control has
    /// been answered: a flourish holds the renderer for the better part of
    /// a second, and the sender of the next control has less than that
    /// before it gives up. So the flourish asks whether anything is
    /// waiting and gives way when there is, rather than the newer action
    /// spending its whole arrival budget on a pipe that is busy drawing
    /// the last one.
    pub(crate) fn control_waiting(&self) -> bool {
        self.waiting.load(Ordering::Acquire)
    }
}

/// `waiting` is raised before the rendezvous hand-over rather than after
/// it, so it is already true for the whole time the serving thread spends
/// finishing the previous control. Raising it after the hand-over would
/// make it true only once the serving thread had already taken the
/// control, which is exactly when nothing needs to know.
#[cfg(target_os = "windows")]
fn accept_loop(
    shared: SharedHandle,
    arrivals: &SyncSender<CursorOverlayControl>,
    release: &Receiver<()>,
    waiting: &AtomicBool,
) {
    let handle = shared.get();
    loop {
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
            return;
        }
        if !peer::peer_is_this_user(handle as isize) {
            unsafe { DisconnectNamedPipe(handle) };
            continue;
        }
        let Some(control) = read_control(handle) else {
            unsafe { DisconnectNamedPipe(handle) };
            continue;
        };
        waiting.store(true, Ordering::Release);
        if arrivals.send(control).is_err() || release.recv().is_err() {
            return;
        }
    }
}

/// One control from a connected client, or `None` when it wrote nothing
/// legible inside its window. The connection is left open for the caller
/// to close, so the decision to disconnect lives in one place.
///
/// Bytes accumulate across polls. This is a byte-mode pipe, so a payload
/// the client wrote in one call can still arrive in two reads, and
/// decoding whichever half turned up first threw away a control its
/// sender then waited out its whole budget for. A prefix of JSON cannot
/// decode, so retrying the decode on every poll can never accept a
/// half-written control as a whole one.
#[cfg(target_os = "windows")]
fn read_control(handle: HANDLE) -> Option<CursorOverlayControl> {
    let deadline = Instant::now() + PAYLOAD_WAIT;
    let mut payload: Vec<u8> = Vec::new();
    loop {
        let mut available = 0u32;
        let peeked = unsafe {
            PeekNamedPipe(
                handle,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if peeked == 0 {
            return None;
        }
        if available > 0 {
            let room = framing::MAX_CONTROL_BYTES.saturating_sub(payload.len());
            if room == 0 {
                return None;
            }
            let mut chunk = vec![0u8; room];
            let mut read = 0u32;
            let ok = unsafe {
                ReadFile(
                    handle,
                    chunk.as_mut_ptr(),
                    (available as usize).min(room) as u32,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 || read == 0 {
                return None;
            }
            chunk.truncate(read as usize);
            payload.extend_from_slice(&chunk);
            if let Ok(control) = framing::decode(&payload) {
                return accepted(control);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// A decoded control still has to pass the checks core defines for it
/// before it is drawn.
///
/// Decoding proves only that the bytes were the shape of a control. The
/// session id is a path component and the destination is a coordinate the
/// renderer maps onto a monitor, and both arrive from another process, so
/// what the sending side validated before it wrote is validated again by
/// the side that reads.
#[cfg(target_os = "windows")]
fn accepted(control: CursorOverlayControl) -> Option<CursorOverlayControl> {
    match control.validate() {
        Ok(()) => Some(control),
        Err(error) => {
            tracing::debug!(
                code = %error.code.as_str(),
                "a cursor overlay control was refused by its own validation"
            );
            None
        }
    }
}
