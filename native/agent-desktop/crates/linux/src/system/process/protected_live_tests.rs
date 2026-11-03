use std::time::{Duration, Instant};

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode};

use super::is_protected;
use super::session_origin::LAUNCH_MARKER;
use crate::system::close::close_app;
use crate::system::close::close_live_tests::rig::{Orphan, lease};
use crate::system::close::close_live_tests::{listed, portal_backend};
use crate::system::{SharedBus, app_inventory};

const PLAIN: &str = "org.freedesktop.impl.portal.desktop.PlainFixture";
const LAUNCHED: &str = "org.freedesktop.impl.portal.desktop.LaunchedFixture";
const WINDOWLESS: &str = "org.freedesktop.impl.portal.desktop.WindowlessFixture";
const HUNG_REFUSED: &str = "org.freedesktop.impl.portal.desktop.HungRefusedFixture";

fn protected(orphan: &Orphan) -> bool {
    let deadline = Deadline::after(10_000).expect("a deadline builds");
    is_protected(&SharedBus::default(), orphan.pid, &orphan.token, deadline)
        .expect("the ownership of the process is readable")
}

#[test]
#[ignore = "starts owned portal backends on a private session bus"]
fn a_silent_process_that_owns_a_service_name_is_protected_unless_a_launch_of_this_tool_started_it()
{
    let plain = portal_backend(PLAIN, &[]);
    let launched = portal_backend(LAUNCHED, &[(LAUNCH_MARKER, "1".to_owned())]);
    assert!(
        protected(&plain),
        "a process the session could have started for its name is protected"
    );
    assert!(
        !protected(&launched),
        "a process a launch of this tool started is never protected by a name it owns"
    );
    println!(
        "independent D-Bus credentials: pid {} and pid {} own a service name each; only the one without the launch marker is protected",
        plain.pid, launched.pid
    );
}

#[test]
#[ignore = "drives real desktop applications; run through scripts/private-session.sh --wm"]
fn a_hung_application_with_a_window_is_force_closed_and_a_hung_windowless_name_owner_is_refused() {
    let bus = SharedBus::default();
    let editor = Orphan::spawn("gnome-text-editor", &["--new-window"], &[]);
    let app = listed(&bus, editor.pid);
    editor.stop();
    let graceful = close_app(&bus, &app, false, &lease(10_000)).expect_err("stopped");
    assert_eq!(graceful.code, ErrorCode::AppUnresponsive);
    assert!(editor.alive(), "a graceful close signals nothing");
    close_app(&bus, &app, true, &lease(10_000)).expect("a forced close ends a hung application");
    assert!(!editor.alive());

    let backend = portal_backend(HUNG_REFUSED, &[]);
    backend.stop();
    for force in [false, true] {
        let error = close_app(
            &bus,
            &backend.app("ordinary application"),
            force,
            &lease(5_000),
        )
        .expect_err("protected");
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert!(backend.alive(), "force={force}");
    }
}

/// A process that registers on the accessibility bus, owns `service` on the
/// session bus and shows no window.
fn windowless_application(service: &str) -> Orphan {
    let runtime = std::path::PathBuf::from(std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").unwrap());
    let script = runtime.join(format!("{service}.py"));
    std::fs::write(
        &script,
        format!(
            r#"
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gio, Gtk
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
Gio.bus_own_name_on_connection(bus, '{service}', Gio.BusNameOwnerFlags.NONE, None, None)
Gtk.main()
"#
        ),
    )
    .unwrap();
    let orphan = Orphan::spawn("python3", &[script.to_str().unwrap()], &[]);
    let started = Instant::now();
    while !app_inventory(
        &SharedBus::default(),
        Deadline::after(10_000).expect("a deadline builds"),
    )
    .is_ok_and(|found| found.apps.iter().any(|app| app.pid == orphan.pid))
    {
        assert!(
            started.elapsed() < Duration::from_secs(40),
            "the application never registered"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
    orphan
}

#[test]
#[ignore = "drives a native Wayland application; run through scripts/private-session.sh -- scripts/private-wayland-shell.sh"]
fn a_native_wayland_application_is_cleared_by_its_tree_and_a_windowless_one_is_not() {
    let bus = SharedBus::default();
    let editor = Orphan::spawn(
        "gnome-text-editor",
        &["--new-window"],
        &[("GDK_BACKEND", "wayland".to_owned())],
    );
    listed(&bus, editor.pid);
    let backend = windowless_application(WINDOWLESS);
    assert_eq!(
        editor.window_count(),
        0,
        "the premise: the window manager manages no window of it"
    );
    assert!(
        !protected(&editor),
        "an application with a window in its tree is not a session service"
    );
    assert!(
        protected(&backend),
        "an application that owns a session-bus name and lists no window is protected"
    );
}
