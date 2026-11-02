#[cfg(target_os = "linux")]
use std::os::unix::net::UnixListener;

use super::{SocketProbe, local_number, reach_from};
use crate::system::display::display_reach::Reach;
use crate::system::display::display_server::Probe;

const HEADER: &str = "Num       RefCount Protocol Flags    Type St Inode Path\n";

fn table(rows: &[&str]) -> String {
    format!("{HEADER}{}", rows.join("\n"))
}

#[test]
fn a_listening_file_socket_is_reachable() {
    let rows = table(&[
        "0000000000000000: 00000002 00000000 00010000 0001 01 4242 /run/user/1000/wayland-0",
    ]);
    assert_eq!(
        reach_from(&rows, "/run/user/1000/wayland-0", true),
        Reach::Connected
    );
}

#[test]
fn a_listening_abstract_socket_is_reachable_without_a_file() {
    let rows =
        table(&["0000000000000000: 00000002 00000000 00010000 0001 01 7 @/tmp/.X11-unix/X1"]);
    assert_eq!(
        reach_from(&rows, "/tmp/.X11-unix/X1", false),
        Reach::Connected
    );
}

#[test]
fn a_socket_file_nobody_listens_on_is_refused() {
    let connected_client =
        table(&["0000000000000000: 00000003 00000000 00000000 0001 03 9 /run/user/1000/wayland-0"]);
    assert_eq!(
        reach_from(&connected_client, "/run/user/1000/wayland-0", true),
        Reach::Refused
    );
    assert_eq!(
        reach_from(&table(&[]), "/run/user/1000/wayland-0", true),
        Reach::Refused
    );
}

#[test]
fn a_path_with_no_file_and_no_listener_is_missing() {
    let rows = table(&["0000000000000000: 00000002 00000000 00010000 0001 01 4242 /run/other"]);
    assert_eq!(
        reach_from(&rows, "/run/user/1000/wayland-9", false),
        Reach::Missing
    );
}

#[test]
fn only_local_display_names_have_a_number() {
    assert_eq!(local_number(":1"), Some("1"));
    assert_eq!(local_number(":12.0"), Some("12"));
    assert_eq!(local_number("unix:3"), Some("3"));
    assert_eq!(local_number("host:0"), None);
    assert_eq!(local_number(":"), None);
    assert_eq!(local_number(":x"), None);
}

#[test]
fn a_remote_display_is_assumed_reachable_because_it_is_not_probed() {
    assert_eq!(SocketProbe.x11("host:0"), Reach::Connected);
}

#[cfg(target_os = "linux")]
#[test]
fn the_kernel_table_sees_a_real_listener_and_then_its_stale_file() {
    let dir = std::env::temp_dir().join(format!("ad-probe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let live = dir.join("live");
    let listener = UnixListener::bind(&live).expect("bind");
    assert_eq!(SocketProbe.wayland(&live), Reach::Connected);
    drop(listener);
    assert_eq!(SocketProbe.wayland(&live), Reach::Refused);
    assert_eq!(SocketProbe.wayland(&dir.join("absent")), Reach::Missing);
    std::fs::remove_dir_all(&dir).expect("cleanup");
}
