use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

pub(super) struct BoundedWriter<W: Write + AsRawFd> {
    output: W,
    original_flags: i32,
    timeout: Duration,
    deadline: Option<Instant>,
}

impl<W: Write + AsRawFd> BoundedWriter<W> {
    pub(super) fn new(output: W, timeout: Duration) -> io::Result<Self> {
        let original_flags = unsafe { libc::fcntl(output.as_raw_fd(), libc::F_GETFL) };
        if original_flags < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe {
            libc::fcntl(
                output.as_raw_fd(),
                libc::F_SETFL,
                original_flags | libc::O_NONBLOCK,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            output,
            original_flags,
            timeout,
            deadline: None,
        })
    }

    fn attempt<T>(&mut self, mut operation: impl FnMut(&mut W) -> io::Result<T>) -> io::Result<T> {
        let deadline = *self
            .deadline
            .get_or_insert_with(|| Instant::now() + self.timeout);
        loop {
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            match operation(&mut self.output) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    super::input::wait_ready(self.output.as_raw_fd(), libc::POLLOUT, deadline)?;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                result => return result,
            }
        }
    }
}

impl<W: Write + AsRawFd> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.attempt(|output| output.write(bytes))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.attempt(Write::flush)?;
        self.deadline = None;
        Ok(())
    }
}

impl<W: Write + AsRawFd> Drop for BoundedWriter<W> {
    fn drop(&mut self) {
        unsafe { libc::fcntl(self.output.as_raw_fd(), libc::F_SETFL, self.original_flags) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;

    #[test]
    fn output_deadline_stops_dispatch_after_one_command() {
        let (sender, _unread_receiver) = UnixStream::pair().unwrap();
        let writer = BoundedWriter::new(sender, Duration::from_millis(20)).unwrap();
        let mut calls = 0;
        let error = super::super::serve(io::Cursor::new(b"[]\n[]\n"), writer, |_| {
            calls += 1;
            agent_desktop_core::response::output::Response::ok(
                "snapshot",
                serde_json::json!({
                    "tree": "x".repeat(4 * 1024 * 1024),
                }),
            )
        })
        .unwrap_err();
        assert!(matches!(error, agent_desktop_core::AppError::Io(error)
            if error.kind() == io::ErrorKind::TimedOut));
        assert_eq!(calls, 1);
    }

    #[test]
    fn complete_frames_reset_the_budget_and_restore_nonblocking_mode() {
        for initially_nonblocking in [false, true] {
            let (sender, mut receiver) = UnixStream::pair().unwrap();
            sender.set_nonblocking(initially_nonblocking).unwrap();
            {
                let mut writer =
                    BoundedWriter::new(sender.try_clone().unwrap(), Duration::from_secs(60))
                        .unwrap();
                let flags = unsafe { libc::fcntl(sender.as_raw_fd(), libc::F_GETFL) };
                assert!(flags >= 0);
                assert_ne!(flags & libc::O_NONBLOCK, 0);
                writer.write_all(b"one\n").unwrap();
                assert!(writer.deadline.is_some());
                writer.flush().unwrap();
                assert!(writer.deadline.is_none());
                writer.write_all(b"two\n").unwrap();
                writer.flush().unwrap();
            }
            let flags = unsafe { libc::fcntl(sender.as_raw_fd(), libc::F_GETFL) };
            assert!(flags >= 0);
            assert_eq!(flags & libc::O_NONBLOCK != 0, initially_nonblocking);
            let mut bytes = [0; 8];
            receiver.read_exact(&mut bytes).unwrap();
            assert_eq!(&bytes, b"one\ntwo\n");
        }
    }
}
