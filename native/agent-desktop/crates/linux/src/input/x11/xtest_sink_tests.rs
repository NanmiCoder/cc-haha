use std::net::TcpListener;
use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, DeliverySemantics};

use super::XtestSink;
use crate::input::x11::live_tests::refuse_live_display;

const TCP_PORT_BASE: u16 = 6_000;

#[test]
fn a_display_that_never_answers_ends_the_connect_at_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a listening socket");
    let port = listener.local_addr().expect("its address").port();
    let display = format!("127.0.0.1:{}", port - TCP_PORT_BASE);
    refuse_live_display(&display);
    let deadline = Deadline::after(300).expect("the deadline builds");
    let started = Instant::now();

    let outcome = XtestSink::connect(&display, deadline, Duration::from_secs(60));

    let error = outcome.err().expect("a silent display is not a connection");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    drop(listener);
}
