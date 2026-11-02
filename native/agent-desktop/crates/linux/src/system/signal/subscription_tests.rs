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

fn atspi() -> (MatchRule<'static>, Relevant) {
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .build();
    (rule, Box::new(|message| from_application(message, &[])))
}

fn signal(server: &Connection) {
    let message =
        zbus::Message::signal("/accessible", "org.a11y.atspi.Event.Object", "StateChanged")
            .unwrap()
            .sender(":1.42")
            .unwrap()
            .build(&())
            .unwrap();
    zbus::block_on(server.send(&message)).unwrap();
}

#[test]
fn a_change_before_blocking_is_latched_and_drop_joins_without_another_event() {
    let (client, server) = pair();
    let (rule, relevant) = atspi();
    let mut subscription =
        Subscription::listen(&client, rule, 0, relevant, Deadline::standard().unwrap()).unwrap();
    for _ in 0..QUEUE * 3 {
        signal(&server);
    }
    let (sent, received) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        subscription.wait(Deadline::after(10_000).unwrap()).unwrap();
        drop(subscription);
        sent.send(()).unwrap();
    });
    received
        .recv_timeout(Duration::from_secs(2))
        .expect("queued wake and cancellation must finish without a fallback poll");
    worker.join().unwrap();
}

#[test]
fn disconnect_retires_the_wake_source_instead_of_proving_absence() {
    let (client, server) = pair();
    let (rule, relevant) = atspi();
    let mut subscription =
        Subscription::listen(&client, rule, 0, relevant, Deadline::standard().unwrap()).unwrap();
    zbus::block_on(server.close()).unwrap();
    assert!(subscription.wait(Deadline::after(2_000).unwrap()).is_err());
}
