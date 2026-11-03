use std::io::Read;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use super::IoCutoff;

#[test]
fn a_read_blocked_on_a_silent_peer_ends_when_the_cutoff_fires() {
    let (mut near, _far) = UnixStream::pair().expect("a socket pair");
    near.set_read_timeout(Some(Duration::from_secs(5)))
        .expect("timeout");
    let _cutoff = IoCutoff::arm(near.as_fd(), Duration::from_millis(100)).expect("arms");
    let started = Instant::now();

    let mut byte = [0_u8; 1];
    let read = near
        .read(&mut byte)
        .expect("the shutdown reads as end of stream");

    assert_eq!(read, 0);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn a_disarmed_cutoff_leaves_the_socket_open() {
    let (near, mut far) = UnixStream::pair().expect("a socket pair");
    far.set_read_timeout(Some(Duration::from_millis(400)))
        .expect("timeout");
    drop(IoCutoff::arm(near.as_fd(), Duration::from_millis(100)).expect("arms"));
    std::thread::sleep(Duration::from_millis(250));

    let mut byte = [0_u8; 1];
    let error = far
        .read(&mut byte)
        .expect_err("the peer is still open and silent");

    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ));
}
