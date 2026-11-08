use super::SessionKey;

fn key(bus: Option<&str>, runtime: Option<&str>) -> SessionKey {
    SessionKey {
        bus: bus.map(str::to_owned),
        runtime: runtime.map(str::to_owned),
    }
}

fn environ(entries: &[&str]) -> Vec<u8> {
    entries.join("\0").into_bytes()
}

#[test]
fn session_ownership_requires_an_exact_bus_or_runtime_match() {
    let ours = key(Some("unix:path=/a/bus"), Some("/a"));
    assert!(ours.owns(Some(&environ(&[
        "HOME=/h",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/a/bus"
    ]))));
    assert!(ours.owns(Some(&environ(&["DBUS_STARTER_ADDRESS=unix:path=/a/bus"]))));
    assert!(ours.owns(Some(&environ(&["XDG_RUNTIME_DIR=/a"]))));
    assert!(!ours.owns(Some(&environ(&[
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/b/bus",
        "XDG_RUNTIME_DIR=/b"
    ]))));
    assert!(!ours.owns(Some(&environ(&["HOME=/h"]))));
    assert!(!ours.owns(Some(&[])));
    assert!(!key(Some("unix:path=/a/bus"), None).owns(None));
    assert!(key(None, None).owns(None));
    assert!(key(None, None).owns(Some(&environ(&["XDG_RUNTIME_DIR=/b"]))));
    let ours = key(None, Some("/run/user/1000"));
    assert!(!ours.owns(Some(&environ(&["XDG_RUNTIME_DIR=/run/user/10000"]))));
}

const RUNTIME: &str = "/run/user/test-session-a";
const BUS: &str = "unix:path=/run/user/test-session-a/bus";

fn this_session() -> SessionKey {
    key(Some(BUS), Some(RUNTIME))
}

fn environment_of_session_a() -> Vec<u8> {
    environ(&["HOME=/h", &format!("DBUS_SESSION_BUS_ADDRESS={BUS}")])
}

#[test]
fn proc_scan_finds_our_process_and_rejects_it_from_another_session() {
    let pid = std::process::id();
    let facts = crate::system::process::process_facts::read(pid).expect("this process is readable");
    let name = crate::system::app::app_name::app_name(&facts);
    let only_this_process = |environment: Vec<u8>| {
        move |candidate: u32| (candidate == pid).then(|| environment.clone())
    };
    let found = super::find_with_environ(
        &name,
        &this_session(),
        &only_this_process(environment_of_session_a()),
    );
    assert_eq!(found, Some((pid, facts.comm.clone())));
    let elsewhere = key(
        Some("unix:path=/run/user/test-session-b/bus"),
        Some("/run/user/test-session-b"),
    );
    let other_session = super::find_with_environ(
        &name,
        &elsewhere,
        &only_this_process(environment_of_session_a()),
    );
    assert_eq!(other_session, None);
}
