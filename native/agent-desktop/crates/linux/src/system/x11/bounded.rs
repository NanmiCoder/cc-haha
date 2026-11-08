use std::cell::RefCell;
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread;

use agent_desktop_core::Deadline;
use x11rb::errors::ConnectError;
use x11rb::reexports::x11rb_protocol::{
    parse_display::{ConnectAddress, parse_display},
    xauth::get_auth,
};
use x11rb::rust_connection::{DefaultStream, RustConnection};

type Sockets = Arc<Mutex<(bool, Vec<UnixStream>)>>;

thread_local! {
    static CURRENT: RefCell<Option<Sockets>> = const { RefCell::new(None) };
}

fn register(stream: &impl AsFd) -> std::io::Result<()> {
    CURRENT.with_borrow(|current| {
        if let Some(current) = current {
            let socket = UnixStream::from(stream.as_fd().try_clone_to_owned()?);
            let mut state = current.lock().unwrap_or_else(|error| error.into_inner());
            if state.0 {
                socket.shutdown(Shutdown::Both)?;
            } else {
                state.1.push(socket);
            }
        }
        Ok(())
    })
}

fn cancellable<T>(
    work: impl std::future::Future<Output = std::io::Result<T>>,
) -> std::io::Result<T> {
    if CURRENT.with_borrow(|current| current.is_none()) {
        return async_io::block_on(work);
    }
    let (shutdown, wake) = UnixStream::pair()?;
    register(&shutdown)?;
    drop(shutdown);
    let wake = async_io::Async::new(wake)?;
    async_io::block_on(futures_lite::future::or(work, async {
        wake.readable().await?;
        Err(std::io::Error::from(std::io::ErrorKind::Interrupted))
    }))
}

fn open_stream(
    address: &ConnectAddress<'_>,
) -> std::io::Result<(
    DefaultStream,
    (x11rb::reexports::x11rb_protocol::xauth::Family, Vec<u8>),
)> {
    match address {
        ConnectAddress::Socket(path) => {
            let stream = cancellable(async_io::Async::<UnixStream>::connect(path))?.into_inner()?;
            DefaultStream::from_unix_stream(stream)
        }
        ConnectAddress::Hostname(host, port) => {
            let mut last = std::io::Error::from(std::io::ErrorKind::AddrNotAvailable);
            for address in (*host, *port).to_socket_addrs()? {
                match cancellable(async_io::Async::<TcpStream>::connect(address)) {
                    Ok(stream) => return DefaultStream::from_tcp_stream(stream.into_inner()?),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                        return Err(error);
                    }
                    Err(error) => last = error,
                }
            }
            Err(last)
        }
        _ => Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
    }
}

/// Registers the transport before the setup handshake, which can itself
/// block when a listening display server never sends its setup reply.
pub(crate) fn connect(display: &str) -> Result<(RustConnection, usize), ConnectError> {
    let parsed = parse_display(Some(display))?;
    let screen = usize::from(parsed.screen);
    let mut last = None;
    for address in parsed.connect_instruction() {
        let (stream, (family, name)) = match open_stream(&address) {
            Ok(connected) => connected,
            Err(error) => {
                last = Some(error);
                continue;
            }
        };
        register(&stream)?;
        let (auth_name, auth_data) = get_auth(family, &name, parsed.display)
            .unwrap_or(None)
            .unwrap_or_default();
        let connection =
            RustConnection::connect_to_stream_with_auth_info(stream, screen, auth_name, auth_data)?;
        return Ok((connection, screen));
    }
    Err(last
        .map(ConnectError::IoError)
        .unwrap_or(ConnectError::InvalidScreen))
}

/// A display-server read running on its own thread: X11 property and RandR
/// replies are synchronous round trips to a display server that cannot be
/// allowed to stall the caller, so the caller bounds every read by
/// `Deadline`.
pub(crate) struct PendingRead<T> {
    receiver: Option<Receiver<T>>,
    worker: Option<thread::JoinHandle<()>>,
    sockets: Sockets,
}

struct ReaderPool {
    active: AtomicUsize,
    limit: usize,
}

struct Permit(&'static ReaderPool);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Release);
    }
}

impl ReaderPool {
    const fn new(limit: usize) -> Self {
        Self {
            active: AtomicUsize::new(0),
            limit,
        }
    }

    fn start<T: Send + 'static>(
        &'static self,
        read: impl FnOnce() -> T + Send + 'static,
    ) -> PendingRead<T> {
        let (sender, receiver) = channel();
        let sockets = Arc::new(Mutex::new((false, Vec::new())));
        let mut pending = PendingRead {
            receiver: None,
            worker: None,
            sockets,
        };
        if self
            .active
            .fetch_update(Ordering::Acquire, Ordering::Relaxed, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .is_err()
        {
            return pending;
        }
        let permit = Permit(self);
        let registered = pending.sockets.clone();
        let worker = thread::Builder::new()
            .name("x11-read".to_owned())
            .spawn(move || {
                let _permit = permit;
                let masked = unsafe {
                    let mut signals = std::mem::zeroed();
                    libc::sigemptyset(&mut signals);
                    libc::sigaddset(&mut signals, libc::SIGPIPE);
                    libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut())
                };
                if masked != 0 {
                    return;
                }
                CURRENT.with_borrow_mut(|current| *current = Some(registered));
                let _ = sender.send(read());
                CURRENT.with_borrow_mut(|current| *current = None);
            })
            .ok();
        pending.receiver = worker.as_ref().map(|_| receiver);
        pending.worker = worker;
        pending
    }
}

/// Limits even workers blocked in DNS/NSS before a cancellable socket exists.
/// The worker owns its permit until exit, including after caller timeout.
static READERS: ReaderPool = ReaderPool::new(16);

/// Starts a bounded read; saturation or spawn failure returns an absent answer.
pub(crate) fn start<T: Send + 'static>(
    read: impl FnOnce() -> T + Send + 'static,
) -> PendingRead<T> {
    READERS.start(read)
}

impl<T> PendingRead<T> {
    /// The answer, or `None` when the deadline passes first, the thread
    /// panicked, or the thread was never spawned.
    pub(crate) fn finish(mut self, deadline: Deadline) -> Option<T> {
        let answer = self
            .receiver
            .take()
            .and_then(|receiver| receiver.recv_timeout(deadline.remaining()).ok());
        if answer.is_some() {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
            self.sockets
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .1
                .clear();
        }
        answer
    }
}

impl<T> Drop for PendingRead<T> {
    fn drop(&mut self) {
        let registered = {
            let mut state = self
                .sockets
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.0 = true;
            let registered = !state.1.is_empty();
            for socket in state.1.drain(..) {
                let _ = socket.shutdown(Shutdown::Both);
            }
            registered
        };
        if registered && let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "bounded_tests.rs"]
mod tests;
