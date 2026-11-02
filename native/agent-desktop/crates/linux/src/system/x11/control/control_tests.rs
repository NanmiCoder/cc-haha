use agent_desktop_core::Deadline;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::ControlRead;
use crate::system::display::display_cause::Cause;
use crate::system::display::display_server::DisplayServer;
use crate::system::display::display_unavailable::Unavailable;
use crate::system::x11::control_display::route_for;

fn deadline(ms: u64) -> Deadline {
    Deadline::after(ms).expect("a deadline builds")
}

fn x11() -> DisplayServer {
    DisplayServer::X11(":99".to_owned())
}

#[test]
fn the_read_gets_the_display_of_the_session() {
    let seen = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&seen);
    route_for(x11(), None, deadline(2_000), move |display| {
        *sink.lock().expect("the lock is not poisoned") = display;
        ControlRead::Ready(())
    });
    assert_eq!(*seen.lock().expect("the lock is not poisoned"), ":99");
}

#[test]
fn a_wayland_session_is_not_x11_and_opens_no_connection() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    let read = route_for(DisplayServer::Wayland, None, deadline(2_000), move |_| {
        flag.store(true, Ordering::SeqCst);
        ControlRead::Ready(())
    });
    assert_eq!(read, ControlRead::NotX11);
    assert!(!ran.load(Ordering::SeqCst));
}

#[test]
fn a_session_with_no_display_is_unavailable_and_opens_no_connection() {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    let gone = DisplayServer::Unavailable(Unavailable {
        cause: Cause::NotConfigured,
        detail: String::new(),
    });
    let read = route_for(gone, None, deadline(2_000), move |_| {
        flag.store(true, Ordering::SeqCst);
        ControlRead::Ready(())
    });
    assert_eq!(read, ControlRead::Unavailable);
    assert!(!ran.load(Ordering::SeqCst));
}

#[test]
fn a_wayland_session_with_an_xwayland_display_reads_it() {
    let read = route_for(
        DisplayServer::Wayland,
        Some(":7".to_owned()),
        deadline(2_000),
        ControlRead::Ready,
    );
    assert_eq!(read, ControlRead::Ready(":7".to_owned()));
}

#[test]
fn a_wayland_session_whose_xwayland_does_not_answer_is_not_x11() {
    let read = route_for(
        DisplayServer::Wayland,
        Some(":7".to_owned()),
        deadline(2_000),
        |_| -> ControlRead<u32> { ControlRead::Unavailable },
    );
    assert_eq!(read, ControlRead::NotX11);
}
