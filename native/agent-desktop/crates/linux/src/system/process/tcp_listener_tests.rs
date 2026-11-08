use super::*;
use std::net::TcpListener;

#[test]
fn listener_ownership_matches_the_current_process_generation() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
    let port = listener.local_addr().expect("listener address").port();
    let pid = std::process::id();
    let facts = super::super::process_facts::read(pid).expect("current process facts");
    let process = ProcessIdentity::new(pid, facts.instance);

    assert!(owns_listener(&process, port, Deadline::after(1_000).unwrap()).unwrap());
    assert!(
        !owns_listener(
            &ProcessIdentity::new(pid, "stale-generation"),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
}

#[test]
fn listener_ownership_rejects_an_unrelated_process_identity() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
    let port = listener.local_addr().expect("listener address").port();
    let mut child = std::process::Command::new("sleep")
        .arg("1")
        .spawn()
        .expect("spawn unrelated process");
    let facts = super::super::process_facts::read(child.id()).expect("child process facts");

    assert!(
        !owns_listener(
            &ProcessIdentity::new(child.id(), facts.instance),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
    let _ = child.kill();
    let _ = child.wait();
}
