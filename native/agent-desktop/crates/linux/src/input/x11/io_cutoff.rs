use std::io;
use std::os::fd::BorrowedFd;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::thread;
use std::time::Duration;

/// Shuts the display socket down once `after` has passed, so that a request
/// blocked on a stalled server fails instead of waiting for ever. Dropping it
/// disarms the cutoff.
pub(crate) struct IoCutoff {
    _disarm: Sender<()>,
}

impl IoCutoff {
    pub(crate) fn arm(socket: BorrowedFd<'_>, after: Duration) -> io::Result<Self> {
        let socket = UnixStream::from(socket.try_clone_to_owned()?);
        let (disarm, armed) = channel::<()>();
        thread::Builder::new()
            .name("x11-io-cutoff".to_owned())
            .spawn(move || {
                if armed.recv_timeout(after) == Err(RecvTimeoutError::Timeout) {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
            })?;
        Ok(Self { _disarm: disarm })
    }
}

#[cfg(test)]
#[path = "io_cutoff_tests.rs"]
mod tests;
