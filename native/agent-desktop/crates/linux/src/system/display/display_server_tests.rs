use std::cell::RefCell;
use std::path::{Path, PathBuf};

use super::{Cause, DisplayEnv, DisplayServer, Probe, Reach, Unavailable, detect};

struct Fixed {
    wayland: Reach,
    x11: Reach,
    sockets: RefCell<Vec<PathBuf>>,
}

fn probe(wayland: Reach, x11: Reach) -> Fixed {
    Fixed {
        wayland,
        x11,
        sockets: RefCell::new(Vec::new()),
    }
}

impl Probe for Fixed {
    fn wayland(&self, socket: &Path) -> Reach {
        self.sockets.borrow_mut().push(socket.to_path_buf());
        self.wayland
    }

    fn x11(&self, _: &str) -> Reach {
        self.x11
    }
}

fn env(wayland: Option<&str>, display: Option<&str>) -> DisplayEnv {
    DisplayEnv {
        wayland: wayland.map(str::to_owned),
        display: display.map(str::to_owned),
        runtime_dir: Some(PathBuf::from("/run/user/1000")),
    }
}

fn unavailable(server: DisplayServer) -> Unavailable {
    match server {
        DisplayServer::Unavailable(why) => why,
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[test]
fn a_reachable_wayland_socket_wins_over_a_working_display() {
    let server = detect(
        &env(Some("wayland-0"), Some(":0")),
        &probe(Reach::Connected, Reach::Connected),
    );
    assert_eq!(server, DisplayServer::Wayland);
}

#[test]
fn a_stale_wayland_socket_falls_through_to_a_working_display() {
    for stale in [Reach::Missing, Reach::Refused] {
        let server = detect(
            &env(Some("wayland-9"), Some(":0")),
            &probe(stale, Reach::Connected),
        );
        assert_eq!(server, DisplayServer::X11(":0".to_owned()));
    }
}

#[test]
fn the_wayland_socket_is_resolved_under_the_runtime_dir_unless_absolute() {
    let relative = probe(Reach::Connected, Reach::Missing);
    detect(&env(Some("wayland-0"), None), &relative);
    assert_eq!(
        relative.sockets.borrow().as_slice(),
        [PathBuf::from("/run/user/1000/wayland-0")]
    );
    let absolute = probe(Reach::Connected, Reach::Missing);
    detect(&env(Some("/tmp/wl"), None), &absolute);
    assert_eq!(
        absolute.sockets.borrow().as_slice(),
        [PathBuf::from("/tmp/wl")]
    );
}

#[test]
fn a_relative_wayland_name_without_a_runtime_dir_is_missing() {
    let mut bare = env(Some("wayland-0"), None);
    bare.runtime_dir = None;
    let why = unavailable(detect(&bare, &probe(Reach::Connected, Reach::Missing)));
    assert_eq!(why.cause, Cause::Missing);
}

#[test]
fn a_missing_socket_and_a_refused_one_are_told_apart() {
    let missing = unavailable(detect(
        &env(Some("wayland-9"), None),
        &probe(Reach::Missing, Reach::Missing),
    ));
    assert_eq!(missing.cause, Cause::Missing);
    assert!(missing.detail.contains("WAYLAND_DISPLAY=wayland-9"));
    let refused = unavailable(detect(
        &env(None, Some(":4")),
        &probe(Reach::Missing, Reach::Refused),
    ));
    assert_eq!(refused.cause, Cause::Refused);
    assert!(refused.detail.contains("DISPLAY=:4"));
}

#[test]
fn both_failing_reports_both_and_a_refusal_outranks_a_missing_socket() {
    let why = unavailable(detect(
        &env(Some("wayland-9"), Some(":4")),
        &probe(Reach::Missing, Reach::Refused),
    ));
    assert_eq!(why.cause, Cause::Refused);
    assert!(why.detail.contains("WAYLAND_DISPLAY=wayland-9"));
    assert!(why.detail.contains("DISPLAY=:4"));
}

#[test]
fn no_variables_is_not_configured() {
    let why = unavailable(detect(
        &env(None, None),
        &probe(Reach::Connected, Reach::Connected),
    ));
    assert_eq!(why.cause, Cause::NotConfigured);
    assert!(why.detail.is_empty());
}

#[test]
fn a_display_written_with_the_unix_transport_prefix_is_handed_on_without_it() {
    let server = detect(
        &env(None, Some("unix:1.0")),
        &probe(Reach::Missing, Reach::Connected),
    );
    assert_eq!(server, DisplayServer::X11(":1.0".to_owned()));
    let plain = detect(
        &env(None, Some(":2")),
        &probe(Reach::Missing, Reach::Connected),
    );
    assert_eq!(plain, DisplayServer::X11(":2".to_owned()));
    assert_eq!(super::canonical_display("unixhost:0"), "unixhost:0");
}
