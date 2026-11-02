use super::*;

#[test]
fn libproc_attributes_a_tcp_listener_to_the_current_process_generation() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let port = listener.local_addr().expect("listener address").port();
    let pid = i32::try_from(std::process::id()).expect("pid range");
    let instance = crate::system::process::process_identity::token_for_pid(pid)
        .expect("read process identity")
        .expect("process identity");

    assert!(
        owns_listener(
            &ProcessIdentity::new(pid as u32, instance),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
    assert!(
        !owns_listener(
            &ProcessIdentity::new(pid as u32, "macos-proc-v1:0:0"),
            port,
            Deadline::after(1_000).unwrap()
        )
        .unwrap()
    );
}

#[test]
fn socket_info_layout_matches_the_macos_proc_info_abi() {
    assert_eq!(size_of::<SocketInfo>(), 768);
    assert_eq!(std::mem::offset_of!(SocketInfo, receive), 184);
    assert_eq!(std::mem::offset_of!(SocketInfo, kind), 232);
    assert_eq!(std::mem::offset_of!(SocketInfo, protocol_info), 240);
}
