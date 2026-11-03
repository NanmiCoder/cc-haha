use super::*;

#[test]
fn tcp_owner_table_attributes_a_loopback_listener_to_its_process_generation() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let pid = agent_desktop_core::ProcessId::new(std::process::id());
    let instance = crate::system::process_identity::token_for_pid(pid)
        .expect("read process identity")
        .expect("process identity");

    assert!(
        owns_listener(
            &ProcessIdentity::new(pid, instance),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
    assert!(
        !owns_listener(
            &ProcessIdentity::new(pid, "windows-proc-v1:0:0"),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
}
