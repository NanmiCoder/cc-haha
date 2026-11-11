use std::os::unix::net::UnixStream;
use std::time::Instant;

use futures_lite::future;
use zbus::connection::Builder;
use zbus::{Connection, Message};

use super::*;

fn pair() -> (Connection, Connection) {
    let (near, far) = UnixStream::pair().unwrap();
    let (client, server) = zbus::block_on(future::zip(
        Builder::async_io_unix_stream(near).p2p().build(),
        Builder::async_io_unix_stream(far)
            .server(zbus::Guid::generate())
            .unwrap()
            .p2p()
            .build(),
    ));
    (client.unwrap(), server.unwrap())
}

fn held(client: &Connection) -> Box<dyn Held> {
    let rule = MatchRule::builder().msg_type(Type::Signal).build();
    let subscription = Subscription::listen(
        client,
        rule,
        KEPT,
        Box::new(|message| parse(message).is_some()),
        Deadline::standard().unwrap(),
    )
    .unwrap();
    Box::new(subscription)
}

fn send<B: zbus::export::serde::Serialize + zbus::zvariant::DynamicType>(
    server: &Connection,
    member: &str,
    body: &B,
) {
    let message = Message::signal(PATH, INTERFACE, member)
        .unwrap()
        .sender(":1.9")
        .unwrap()
        .build(body)
        .unwrap();
    zbus::block_on(server.send(&message)).unwrap();
}

#[test]
fn both_daemon_signals_are_decoded_and_others_are_ignored() {
    let (client, server) = pair();
    let subscription = held(&client);
    send(&server, "ActionInvoked", &(7u32, "reply"));
    send(&server, "NotificationReplied", &(7u32, "text"));
    send(&server, "NotificationClosed", &(7u32, 2u32));
    let seen = subscription.collect(Duration::from_millis(2_000));
    assert_eq!(seen, vec![Signal::ActionInvoked(7), Signal::Closed(7)]);
}

#[test]
fn a_quiet_gap_after_a_signal_ends_the_wait_before_the_budget() {
    let (client, server) = pair();
    let subscription = held(&client);
    send(&server, "NotificationClosed", &(3u32, 1u32));
    let started = Instant::now();
    let seen = subscription.collect(Duration::from_millis(3_000));
    assert_eq!(seen, vec![Signal::Closed(3)]);
    assert!(started.elapsed() < Duration::from_millis(1_500));
}

#[test]
fn a_budget_with_no_signal_returns_nothing_when_it_is_spent() {
    let (client, _server) = pair();
    let subscription = held(&client);
    let started = Instant::now();
    assert!(subscription.collect(Duration::from_millis(250)).is_empty());
    assert!(started.elapsed() >= Duration::from_millis(200));
}
