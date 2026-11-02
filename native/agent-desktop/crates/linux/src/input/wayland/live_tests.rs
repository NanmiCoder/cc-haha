use agent_desktop_core::{Deadline, ErrorCode};

use super::key_session::KeySession;
use super::live_shell::Shell;
use super::remote_desktop::RemoteDesktop;
use crate::system::SharedBus;
use crate::system::bus::session_bus::SessionBus;
use crate::tree::live::live_launch::Launched;

fn deadline() -> Deadline {
    Deadline::after(20_000).expect("a deadline builds")
}

#[test]
#[ignore = "needs a private Wayland session with a headless gnome-shell; run through scripts/private-session.sh"]
fn remote_desktop_answers_on_the_session_bus_and_not_on_the_accessibility_bus() {
    let _launched = Launched::new();
    let _shell = Shell::start();
    let mut desktop = RemoteDesktop::open(deadline()).expect("the session bus opens");
    desktop.create(deadline()).expect("CreateSession succeeds");
    desktop.start(deadline()).expect("Start succeeds");
    desktop.stop(deadline()).expect("Stop succeeds");

    let accessibility = SharedBus::default()
        .get(deadline())
        .expect("the accessibility bus opens");
    let mut wrong = RemoteDesktop::over(accessibility.inner().clone());
    let error = wrong
        .create(deadline())
        .expect_err("the accessibility bus has no RemoteDesktop");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(SessionBus::get(deadline()).is_ok());
}

#[test]
#[ignore = "starts a headless shell; run inside scripts/private-session.sh"]
fn real_stream_setup_preserves_monitor_errors_and_accepts_a_real_monitor() {
    use crate::input::wayland::pointer_send::run_pointer;
    use agent_desktop_core::{DeliverySemantics, MouseButton, Point, Rect};
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private session");
    let mut launched = Launched::new();
    launched.spawn("pipewire", &[]);
    let socket = std::path::Path::new(&runtime).join("pipewire-0");
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::os::unix::net::UnixStream::connect(&socket).is_err() {
        assert!(
            std::time::Instant::now() < until,
            "private PipeWire did not start"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _shell = Shell::start();
    let displays = crate::system::list_wayland_displays(deadline()).unwrap();
    let monitor = &displays[0];
    let oracle = std::process::Command::new("python3").args(["-c", r#"
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
service = 'org.gnome.Mutter.ScreenCast'
def call(path, interface, method, params):
    return bus.call_sync(service, path, interface, method, params, None,
                         Gio.DBusCallFlags.NONE, 5000, None).unpack()
for connector in ('absent-private-monitor', sys.argv[1]):
    rd = 'org.gnome.Mutter.RemoteDesktop'
    def remote(path, interface, method, params=None):
        return bus.call_sync(rd, path, interface, method, params, None, Gio.DBusCallFlags.NONE, 5000, None).unpack()
    session = remote('/org/gnome/Mutter/RemoteDesktop', rd, 'CreateSession')[0]
    identity = remote(session, 'org.freedesktop.DBus.Properties', 'Get', GLib.Variant('(ss)', (rd + '.Session', 'SessionId')))[0]
    options = {'remote-desktop-session-id': GLib.Variant('s', identity)}
    path = call('/org/gnome/Mutter/ScreenCast', service, 'CreateSession', GLib.Variant('(a{sv})', (options,)))[0]
    try:
        stream = call(path, service + '.Session', 'RecordMonitor', GLib.Variant('(sa{sv})', (connector, {})))
        assert connector == sys.argv[1], 'absent monitor was accepted'
        print('GI stream accepted:', stream)
    except GLib.Error as error:
        assert connector == 'absent-private-monitor' and 'monitor' in str(error), str(error)
        print('GI stream refused:', error)
"#, &monitor.id]).output().unwrap();
    assert!(oracle.status.success(), "{oracle:?}");
    println!("{}", String::from_utf8(oracle.stdout).unwrap());
    let mut invalid = monitor.clone();
    invalid.id = "absent-private-monitor".into();
    invalid.bounds = Rect {
        x: 0.,
        y: 0.,
        width: 1280.,
        height: 800.,
    };
    let mut desktop = RemoteDesktop::open(deadline()).unwrap();
    let error = run_pointer(
        &mut desktop,
        &agent_desktop_core::MouseEvent {
            point: Point { x: 640., y: 16. },
            button: MouseButton::Left,
            kind: agent_desktop_core::MouseEventKind::Click { count: 1 },
            modifiers: Vec::new(),
        },
        &[invalid],
        &mut || Ok(()),
        deadline(),
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert!(
        error
            .platform_detail
            .as_deref()
            .is_some_and(|detail| detail.contains("monitor")),
        "{error:?}"
    );
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    println!(
        "real compositor stream refusal: {:?}",
        error.platform_detail
    );
    desktop.create(deadline()).unwrap();
    desktop.attach_stream(&monitor.id, deadline()).unwrap();
    desktop.start(deadline()).unwrap();
    desktop.stop(deadline()).unwrap();
    println!("real monitor stream accepted: {}", monitor.id);
}
