use agent_desktop_core::{AppError, response::output::Response};
use std::io::{self, BufReader, BufWriter};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Instant;

pub(super) fn run(
    path: &Path,
    mut execute: impl FnMut(&[u8]) -> Response,
    stop_after_reply: impl Fn() -> bool,
) -> Result<(), AppError> {
    validate_parent(path)?;
    let _owner = agent_desktop_core::FileLock::acquire(
        &path.with_extension("owner.lock"),
        agent_desktop_core::Deadline::after(1000)?,
        "command host ownership",
    )?;
    if super::endpoint::validate_socket(path)? {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    loop {
        match super::input::wait_ready(
            listener.as_raw_fd(),
            libc::POLLIN,
            Instant::now() + super::IDLE_TIMEOUT,
        ) {
            Err(error) if error.kind() == io::ErrorKind::TimedOut => return Ok(()),
            result => result?,
        }
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error.into()),
        };
        if let Err(error) = serve_connection(stream, &mut execute) {
            tracing::warn!(%error, "command host connection ended without a complete reply");
        }
        if stop_after_reply() {
            return Ok(());
        }
    }
}

fn validate_parent(path: &Path) -> Result<(), AppError> {
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or_else(|| AppError::invalid_input("Command host socket requires an absolute path"))?;
    super::endpoint::validate_directory(parent)
}

fn serve_connection(
    stream: UnixStream,
    execute: impl FnMut(&[u8]) -> Response,
) -> Result<(), AppError> {
    let mut uid = 0;
    let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    if uid != unsafe { libc::geteuid() } {
        return Err(AppError::invalid_input(
            "Command host peer has a different owner",
        ));
    }
    let mut input = BufReader::new(stream.try_clone()?);
    let mut consumed = false;
    super::serve_frames(
        || {
            if consumed {
                return Ok(Vec::new());
            }
            consumed = true;
            super::input::read_frame(
                &mut input,
                super::MAX_REQUEST_BYTES as usize,
                super::IO_TIMEOUT,
                super::IO_TIMEOUT,
            )
        },
        BufWriter::new(super::output::BoundedWriter::new(
            stream,
            super::IO_TIMEOUT,
        )?),
        execute,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn the_host_returns_after_a_reply_that_asks_it_to_stop() {
        let scratch = super::super::test_dir::TestDir::new();
        std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = scratch.path().join("h.sock");
        let (finished, result) = std::sync::mpsc::channel();
        let server_path = path.clone();
        std::thread::spawn(move || {
            let outcome = run(
                &server_path,
                |_| Response::ok("version", serde_json::json!({})),
                || true,
            );
            finished.send(outcome.is_ok()).unwrap();
        });
        let give_up = Instant::now() + std::time::Duration::from_secs(10);
        let mut client = loop {
            if let Ok(stream) = UnixStream::connect(&path) {
                break stream;
            }
            assert!(Instant::now() < give_up, "host did not bind");
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        client.write_all(b"[]\n").unwrap();
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).unwrap();
        assert!(!reply.is_empty());
        assert_eq!(
            result.recv_timeout(std::time::Duration::from_secs(10)),
            Ok(true)
        );
    }

    #[test]
    fn each_connection_dispatches_only_one_request() {
        let (server, mut client) = UnixStream::pair().unwrap();
        client.write_all(b"[]\n[]\n").unwrap();
        let mut calls = 0;
        serve_connection(server, |_| {
            calls += 1;
            Response::ok("version", serde_json::json!({}))
        })
        .unwrap();
        let mut bytes = Vec::new();
        client.read_to_end(&mut bytes).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(bytes.iter().filter(|byte| **byte == b'\n').count(), 1);
    }
}
