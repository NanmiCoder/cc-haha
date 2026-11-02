use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::raw::c_int;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use agent_desktop_core::Deadline;

use super::progress::Progress;
use super::worker_slot::WorkerSlot;

const SIGNALS: [c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];
const RELEASE_WAIT: Duration = Duration::from_millis(2_000);

static ENABLED: AtomicBool = AtomicBool::new(false);
static PIPE_WRITE: AtomicI32 = AtomicI32::new(-1);
static WATCHER: Mutex<Option<OwnedFd>> = Mutex::new(None);
static CURRENT: Mutex<Option<Target>> = Mutex::new(None);
static PREVIOUS: Mutex<Vec<(c_int, libc::sigaction)>> = Mutex::new(Vec::new());

#[derive(Clone)]
struct Target {
    progress: Arc<Progress>,
    slot: Arc<WorkerSlot>,
}

/// While held and enabled, SIGTERM, SIGINT and SIGHUP stop the running input
/// call and wait for its worker to release what it holds before the signal's
/// own action is taken. A process that never calls `enable` is never touched:
/// a library host owns its signal handlers.
pub(crate) struct Armed {
    installed: bool,
}

/// Turns the signal handling on for the rest of the process. Only the
/// command-line binary calls it.
/// Releases held keys and buttons before SIGTERM, SIGINT or SIGHUP takes effect.
/// CLI hosts enable this; library hosts retain their own signal handlers.
pub fn enable() {
    ENABLED.store(true, Ordering::SeqCst);
}

pub(crate) fn arm(progress: Arc<Progress>, slot: Arc<WorkerSlot>) -> Armed {
    if !ENABLED.load(Ordering::SeqCst) {
        return Armed { installed: false };
    }
    let mut watcher = WATCHER.lock().unwrap_or_else(PoisonError::into_inner);
    if watcher.is_none() {
        let Ok(write_end) = start_watcher() else {
            return Armed { installed: false };
        };
        PIPE_WRITE.store(write_end.as_raw_fd(), Ordering::Relaxed);
        *watcher = Some(write_end);
    }
    *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = Some(Target { progress, slot });
    install();
    Armed { installed: true }
}

impl Armed {
    #[cfg(test)]
    pub(crate) fn installed(&self) -> bool {
        self.installed
    }
}

impl Drop for Armed {
    fn drop(&mut self) {
        if self.installed {
            *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = None;
            restore();
        }
    }
}

pub(super) fn release_before(
    progress: &Progress,
    slot: &Arc<WorkerSlot>,
    wait: Duration,
    then: impl FnOnce(),
) {
    progress.cancel();
    if let Ok(deadline) = Deadline::detached_after(u64::try_from(wait.as_millis()).unwrap_or(0)) {
        let _ = slot.claim(deadline);
    }
    then();
}

extern "C" fn on_signal(signal: c_int) {
    let fd = PIPE_WRITE.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = signal as u8;
        unsafe {
            libc::write(fd, std::ptr::from_ref(&byte).cast(), 1);
        }
    }
}

fn start_watcher() -> std::io::Result<OwnedFd> {
    let mut fds = [0 as c_int; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let read_end = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write_end = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    thread::Builder::new()
        .name("x11-signal-release".to_owned())
        .spawn(move || watch(read_end))?;
    Ok(write_end)
}

fn watch(read_end: OwnedFd) {
    loop {
        let mut byte = 0_u8;
        let read = unsafe {
            libc::read(
                read_end.as_raw_fd(),
                std::ptr::from_mut(&mut byte).cast(),
                1,
            )
        };
        if read != 1 {
            if read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
                continue;
            }
            return;
        }
        let target = CURRENT
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(target) = target {
            release_before(&target.progress, &target.slot, RELEASE_WAIT, || {});
        }
        restore();
        unsafe {
            libc::raise(c_int::from(byte));
        }
    }
}

fn install() {
    let mut previous = PREVIOUS.lock().unwrap_or_else(PoisonError::into_inner);
    if !previous.is_empty() {
        return;
    }
    for signal in SIGNALS {
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as extern "C" fn(c_int) as usize;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            let mut old: libc::sigaction = std::mem::zeroed();
            if libc::sigaction(signal, &action, &mut old) == 0 {
                previous.push((signal, old));
            }
        }
    }
}

fn restore() {
    let mut previous = PREVIOUS.lock().unwrap_or_else(PoisonError::into_inner);
    for (signal, old) in previous.drain(..) {
        unsafe {
            libc::sigaction(signal, &old, std::ptr::null_mut());
        }
    }
}

#[cfg(test)]
#[path = "signal_release_tests.rs"]
mod tests;
