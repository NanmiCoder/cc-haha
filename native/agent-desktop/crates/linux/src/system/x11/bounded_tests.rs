use std::sync::mpsc::{Sender, channel};
use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use super::start;
use crate::system::x11::{X11Source, X11State};

struct Fixed(X11State);

impl X11Source for Fixed {
    fn read(&self) -> X11State {
        self.0.clone()
    }
}

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("deadline")
}

#[test]
fn a_reader_that_never_answers_is_unavailable_within_the_deadline() {
    let (release, blocked): (Sender<()>, _) = channel();
    let started = Instant::now();
    let mut pending = start(move || {
        let _ = blocked.recv();
        X11State::NoWindowManager
    });
    let worker = pending.worker.take().expect("worker");
    let answer = pending.finish(deadline(150));
    assert_eq!(answer, None);
    assert!(started.elapsed() < Duration::from_secs(2));
    release.send(()).expect("late read released");
    worker.join().expect("late answer did not panic");
}

#[test]
fn a_reader_that_panics_is_unavailable_not_a_caller_failure() {
    let answer =
        start(|| -> X11State { panic!("the display server sent garbage") }).finish(deadline(2_000));
    assert_eq!(answer, None);
}

#[test]
fn a_cancelled_reader_does_not_send_sigpipe_to_its_host() {
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::process::Command;
    use x11rb::rust_connection::{DefaultStream, Stream};

    const CHILD: &str = "AGENT_DESKTOP_X11_CANCEL_SIGPIPE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        const FILTER: &str =
            "system::x11::bounded::tests::a_cancelled_reader_does_not_send_sigpipe_to_its_host";
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", FILTER, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .expect("foreign signal policy host");
        assert!(
            output.status.success(),
            "cancelled reader terminated its host: {output:?}"
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "{FILTER} must execute exactly one test: {output:?}"
        );
        return;
    }
    assert_ne!(
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) },
        libc::SIG_ERR
    );
    let unmasked = unsafe {
        let mut signals = std::mem::zeroed();
        libc::sigemptyset(&mut signals);
        libc::sigaddset(&mut signals, libc::SIGPIPE);
        libc::pthread_sigmask(libc::SIG_UNBLOCK, &signals, std::ptr::null_mut())
    };
    assert_eq!(unmasked, 0);
    let (entered, ready) = channel();
    let (wrote, observed) = channel();
    let pending = start(move || {
        let (socket, mut peer) = UnixStream::pair().expect("socket pair");
        peer.set_read_timeout(Some(Duration::from_secs(2)))
            .expect("bounded cancellation oracle");
        super::register(&socket).expect("cancellable transport");
        let (stream, _) = DefaultStream::from_unix_stream(socket).expect("X11 transport");
        entered.send(()).expect("transport ready");
        assert_eq!(peer.read(&mut [0]).expect("cancellation closes socket"), 0);
        let error = stream
            .write(b"request", &mut Vec::new())
            .expect_err("cancelled write");
        wrote.send(error.kind()).expect("write result");
    });
    ready
        .recv_timeout(Duration::from_secs(2))
        .expect("reader ready");
    drop(pending);
    assert_eq!(
        observed
            .recv_timeout(Duration::from_secs(2))
            .expect("host survives"),
        std::io::ErrorKind::BrokenPipe
    );
    assert_eq!(
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) },
        libc::SIG_DFL
    );
}

#[test]
fn work_done_before_the_wait_overlaps_the_read() {
    let (done, ready) = channel();
    let pending = start(move || {
        let answer = Fixed(X11State::NoWindowManager).read();
        done.send(()).expect("ready");
        answer
    });
    ready
        .recv_timeout(Duration::from_secs(2))
        .expect("read finished");
    let started = Instant::now();
    let answer = pending.finish(deadline(2_000));
    assert_eq!(answer, Some(X11State::NoWindowManager));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn a_silent_handshake_releases_the_socket_before_returning() {
    use std::io::Read;
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let port = listener.local_addr().expect("address").port();
    let display = format!("127.0.0.1:{}", port - 6000);
    let (closed, observed) = channel();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("accepted");
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("timeout");
        let mut bytes = [0; 1024];
        loop {
            match socket.read(&mut bytes) {
                Ok(0) => break,
                Ok(_) => {}
                Err(error) => panic!("client did not close: {error}"),
            }
        }
        closed.send(()).expect("observed close");
    });
    let (ended, retired) = channel();
    let pending = start(move || {
        let answer = super::connect(&display);
        let _ = ended.send(());
        answer.is_ok()
    });
    assert_eq!(pending.finish(deadline(150)), None);
    observed
        .recv_timeout(Duration::from_secs(2))
        .expect("socket released at deadline");
    retired
        .recv_timeout(Duration::from_secs(2))
        .expect("worker retired");
    server.join().expect("server ended");
}

#[test]
fn blocked_resolvers_hold_capacity_after_timeout_and_recover_on_exit() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    static POOL: super::ReaderPool = super::ReaderPool::new(2);
    let mut releases = Vec::new();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let (release, blocked) = channel();
        let (entered, started) = channel();
        let mut pending = POOL.start(move || {
            entered.send(()).expect("resolver entered");
            blocked.recv().expect("resolver released");
        });
        started
            .recv_timeout(Duration::from_secs(2))
            .expect("resolver blocked");
        workers.push(pending.worker.take().expect("worker"));
        assert_eq!(pending.finish(deadline(1)), None);
        releases.push(release);
    }
    let ran = Arc::new(AtomicBool::new(false));
    let observed = ran.clone();
    let mut refused = POOL.start(move || observed.store(true, Ordering::SeqCst));
    let spawned = refused.worker.take();
    let answer = refused.finish(deadline(1));
    for release in releases {
        release.send(()).expect("release blocked resolver");
    }
    for worker in workers {
        worker.join().expect("resolver exited");
    }
    if let Some(worker) = spawned {
        worker.join().expect("unexpected worker exited");
        panic!("saturated resolver pool spawned another worker");
    }
    assert_eq!(answer, None);
    assert!(!ran.load(Ordering::SeqCst));
    assert_eq!(POOL.start(|| 42).finish(deadline(2_000)), Some(42));
}
