use agent_desktop_core::{WindowInfo, WindowState};

use super::*;
use crate::system::x11::FrameFacts;
use std::os::unix::net::UnixListener;

#[test]
fn socket_ownership_belongs_to_the_listener_process_not_its_name() {
    let path = std::env::temp_dir().join(format!("ad-owner-{}.sock", std::process::id()));
    let listener = UnixListener::bind(&path).unwrap();
    let mut child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let own = owns_socket(std::process::id(), &path);
    let unrelated = owns_socket(child.id(), &path);
    child.kill().unwrap();
    child.wait().unwrap();
    drop(listener);
    std::fs::remove_file(path).unwrap();
    assert!(own.unwrap());
    assert!(!unrelated.unwrap());
}

fn no() -> Result<bool, AdapterError> {
    Ok(false)
}

fn yes() -> Result<bool, AdapterError> {
    Ok(true)
}

#[test]
fn a_silent_process_is_protected_by_a_session_bus_name_unless_a_launch_started_it() {
    assert!(silent_app_is_session_service(no, || false, yes).unwrap());
    assert!(!silent_app_is_session_service(no, || false, no).unwrap());
    assert!(!silent_app_is_session_service(yes, || false, yes).unwrap());
}

#[test]
fn a_launched_silent_process_is_cleared_without_reading_the_session_bus() {
    let reads = std::cell::Cell::new(0);
    let named = || {
        reads.set(reads.get() + 1);
        yes()
    };
    assert!(!silent_app_is_session_service(yes, || false, named).unwrap());
    assert_eq!(reads.get(), 0);
}

#[test]
fn a_silent_process_with_a_managed_window_is_cleared_without_reading_the_session_bus() {
    let reads = std::cell::Cell::new(0);
    let named = || {
        reads.set(reads.get() + 1);
        yes()
    };
    assert!(!silent_app_is_session_service(no, || true, named).unwrap());
    assert_eq!(reads.get(), 0);
}

#[test]
fn the_measured_session_processes_that_do_not_answer_keep_their_protection_by_their_windows() {
    let measured = [
        ("terminal server with a window", false, true, true, false),
        ("text editor with a window", false, true, true, false),
        (
            "text editor of a launch of this tool",
            true,
            true,
            true,
            false,
        ),
        ("portal backend, no window", false, false, true, true),
        ("portal frontend, no window", false, false, true, true),
    ];
    for (label, launched, has_window, owns_name, protected) in measured {
        let verdict =
            silent_app_is_session_service(|| Ok(launched), || has_window, || Ok(owns_name))
                .unwrap();
        assert_eq!(verdict, protected, "{label}");
    }
}

#[test]
fn a_launch_marker_that_cannot_be_read_refuses_instead_of_protecting_by_name() {
    let unreadable = || Err(unknown());
    let error =
        silent_app_is_session_service(unreadable, || false, yes).expect_err("unproven origin");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
}

fn window(unshown: bool) -> ListedWindow {
    ListedWindow {
        app: 0,
        info: WindowInfo {
            id: "w-1".to_owned(),
            title: "Doc".to_owned(),
            app: "app".to_owned(),
            pid: 1.into(),
            process_instance: None,
            bounds: None,
            state: WindowState::default(),
        },
        active: false,
        modal: false,
        dialog: false,
        frame: FrameFacts {
            size_identity: false,
            pid: 1,
            title: "Doc".to_owned(),
            extents: None,
            global_position: false,
        },
        sheet: false,
        unshown,
    }
}

#[test]
fn a_window_the_manager_manages_shows_a_window_without_reading_the_tree() {
    let reads = std::cell::Cell::new(0);
    let listed = || {
        reads.set(reads.get() + 1);
        Ok(Vec::new())
    };
    assert!(shows_a_window(|| true, listed));
    assert_eq!(reads.get(), 0);
}

#[test]
fn a_shown_window_of_the_tree_shows_a_window_where_the_manager_manages_none() {
    assert!(shows_a_window(|| false, || Ok(vec![window(false)])));
    assert!(shows_a_window(
        || false,
        || Ok(vec![window(true), window(false)])
    ));
}

#[test]
fn a_husk_an_empty_tree_and_an_unreadable_tree_show_no_window() {
    assert!(!shows_a_window(|| false, || Ok(vec![window(true)])));
    assert!(!shows_a_window(|| false, || Ok(Vec::new())));
    assert!(!shows_a_window(|| false, || Err(unknown())));
}

#[test]
fn an_unreachable_display_is_reported_as_the_display_not_as_unproven_ownership() {
    use crate::system::display::display_cause::Cause;
    use crate::system::display::display_unavailable::Unavailable;
    let error = socket_of(DisplayServer::Unavailable(Unavailable {
        cause: Cause::Missing,
        detail: "DISPLAY=:999 names a server that is not running".to_owned(),
    }))
    .expect_err("no socket without a display");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(error.message.contains("display server is not running"));
}
