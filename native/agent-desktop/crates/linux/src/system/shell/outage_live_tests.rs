use std::process::Command;
use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};
use zbus::blocking::Connection;
use zbus::zvariant::OwnedObjectPath;

use super::identity::find_root;
use crate::system::SharedBus;

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const ROOT: &str = "/org/a11y/atspi/accessible/root";
const DBUS: &str = "org.freedesktop.DBus";

fn deadline() -> Deadline {
    Deadline::after(4_000).expect("deadline")
}

fn session() -> Connection {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    Connection::session().expect("private session bus")
}

fn try_owner(connection: &Connection, name: &str) -> Option<u32> {
    connection
        .call_method(
            Some(DBUS),
            "/org/freedesktop/DBus",
            Some(DBUS),
            "GetConnectionUnixProcessID",
            &(name,),
        )
        .ok()?
        .body()
        .deserialize()
        .ok()
}

fn owner(connection: &Connection, name: &str) -> u32 {
    try_owner(connection, name).expect("bus owner")
}

fn oracle(connection: &Connection, pid: u32) -> Option<(String, String)> {
    let children = |name: &str, path: &str| {
        connection
            .call_method(Some(name), path, Some(ACCESSIBLE), "GetChildren", &())
            .ok()?
            .body()
            .deserialize::<Vec<(String, OwnedObjectPath)>>()
            .ok()
    };
    for (name, path) in children("org.a11y.atspi.Registry", ROOT)? {
        if try_owner(connection, &name) != Some(pid) {
            continue;
        }
        for (name, path) in children(&name, path.as_str())? {
            let role = connection
                .call_method(
                    Some(name.as_str()),
                    path.as_str(),
                    Some(ACCESSIBLE),
                    "GetRole",
                    &(),
                )
                .ok()
                .and_then(|reply| reply.body().deserialize::<u32>().ok());
            if role == Some(69) {
                return Some((name, path.to_string()));
            }
        }
    }
    None
}

fn accessibility(session: &Connection) -> Connection {
    let address: String = session
        .call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.a11y.Bus"),
            "GetAddress",
            &(),
        )
        .expect("accessibility address")
        .body()
        .deserialize()
        .expect("address");
    zbus::blocking::connection::Builder::address(address.as_str())
        .expect("address")
        .method_timeout(Duration::from_secs(2))
        .build()
        .expect("independent oracle connection")
}

fn wait_for_root(bus: &SharedBus, connection: &Connection, pid: u32) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(before) = oracle(connection, pid) {
            let found = find_root(bus, deadline());
            if oracle(connection, pid).as_ref() == Some(&before) {
                let root = found.expect("stable independently visible shell window resolves");
                assert_eq!((root.bus_name, root.path), before);
                assert_eq!(root.pid, pid);
                return;
            }
        }
        assert!(
            Instant::now() < until,
            "shell window readiness by direct D-Bus"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "private GNOME shell; run through private-mutter-shell.sh or private-wayland-shell.sh"]
fn shell_live_window_matches_direct_bus_reads_across_notification_posts() {
    let session = session();
    let pid = owner(&session, "org.gnome.Shell");
    let connection = accessibility(&session);
    let bus = SharedBus::default();
    wait_for_root(&bus, &connection, pid);
    for index in 0..3 {
        let title = format!("shell-window-{index}");
        let id: u32 = session
            .call_method(
                Some("org.freedesktop.Notifications"),
                "/org/freedesktop/Notifications",
                Some("org.freedesktop.Notifications"),
                "Notify",
                &(
                    "shell-window-test",
                    0u32,
                    "",
                    title,
                    "oracle",
                    Vec::<String>::new(),
                    std::collections::HashMap::<String, zbus::zvariant::OwnedValue>::new(),
                    0i32,
                ),
            )
            .expect("independent notification sender")
            .body()
            .deserialize()
            .expect("notification id");
        assert!(id > 0);
        wait_for_root(&bus, &connection, pid);
    }
    println!(
        "shell pid {pid}: adapter window equals independent direct D-Bus window before and after three posts"
    );
}

struct Stopped(u32);

impl Drop for Stopped {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-CONT", &self.0.to_string()])
            .status();
    }
}

#[test]
#[ignore = "stops only the owned private shell; run through private-mutter-shell.sh or private-wayland-shell.sh"]
fn shell_live_stopped_process_is_unresponsive_instead_of_a_window_outage() {
    let session = session();
    let pid = owner(&session, "org.gnome.Shell");
    let marker = format!(
        "XDG_RUNTIME_DIR={}",
        std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("runtime")
    );
    assert!(
        std::fs::read(format!("/proc/{pid}/environ"))
            .expect("owned shell")
            .split(|byte| *byte == 0)
            .any(|entry| entry == marker.as_bytes())
    );
    let connection = accessibility(&session);
    let bus = SharedBus::default();
    wait_for_root(&bus, &connection, pid);
    let root = find_root(&bus, deadline()).expect("live shell root");
    assert!(
        Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .expect("stop")
            .success()
    );
    let stopped = Stopped(pid);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let state = std::fs::read_to_string(format!("/proc/{pid}/status")).expect("process oracle");
        if state
            .lines()
            .any(|line| line.starts_with("State:") && line.contains("T (stopped)"))
        {
            break;
        }
        assert!(Instant::now() < until, "SIGSTOP state");
        std::thread::yield_now();
    }
    let error = find_root(&bus, deadline()).expect_err("a stopped shell");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    println!("/proc confirms stopped shell {pid}: {error:?}");
    let landmark = super::anchor::Anchor::Landmark(super::container::Landmark::DateMenu);
    let error = super::container::locate_anchor(
        &bus,
        &root,
        landmark,
        Deadline::after(150).expect("read deadline"),
    )
    .expect_err("cached shell landmark cannot be read while its process is stopped");
    assert_eq!(error.code, ErrorCode::Timeout, "{error:?}");
    drop(stopped);
    wait_for_root(&bus, &connection, pid);
    let unproven = super::anchor::Anchor::Landmark(super::container::Landmark::SystemMenu);
    let error = super::container::locate_anchor(&bus, &root, unproven, deadline())
        .expect_err("a responsive tree does not prove the system menu");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let role: u32 = connection
        .call_method(
            Some(root.bus_name.as_str()),
            root.path.as_str(),
            Some(ACCESSIBLE),
            "GetRole",
            &(),
        )
        .expect("independent landmark read")
        .body()
        .deserialize()
        .expect("landmark role");
    assert_eq!(role, 69);
}
