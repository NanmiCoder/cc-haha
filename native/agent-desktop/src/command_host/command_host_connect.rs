use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Instant;

pub(super) fn connect(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
    if Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut.into());
    }
    let bytes = path.as_os_str().as_bytes();
    let mut address = libc::sockaddr_un {
        sun_len: 0,
        sun_family: libc::AF_UNIX as libc::sa_family_t,
        sun_path: [0; 104],
    };
    if bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    for (target, source) in address.sun_path.iter_mut().zip(bytes) {
        *target = *source as libc::c_char;
    }
    address.sun_len = (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as u8;
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = UnixStream::from(socket);
    stream.set_nonblocking(true)?;
    let result = unsafe {
        libc::connect(
            stream.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            address.sun_len as libc::socklen_t,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::EINPROGRESS | libc::EINTR)) {
            return Err(error);
        }
        super::input::wait_ready(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
        if let Some(error) = stream.take_error()? {
            return Err(error);
        }
    }
    if Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut.into());
    }
    stream.set_nonblocking(false)?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::super::test_dir::TestDir;
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::time::Duration;

    #[test]
    fn expired_connection_budget_does_not_enqueue_a_client() {
        let dir = TestDir::new();
        let path = dir.path().join("connect.sock");
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            connect(&path, Instant::now()).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        let stream = connect(&path, Instant::now() + Duration::from_secs(10)).unwrap();
        let _accepted = listener.accept().unwrap();
        assert!(stream.peer_addr().is_ok());
    }
}
