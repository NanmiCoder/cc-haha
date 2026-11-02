use std::sync::{Arc, Mutex};

use agent_desktop_core::{Deadline, DeliverySemantics, ErrorCode, MouseButton, Point};
use zbus::connection::Builder;
use zbus::zvariant::OwnedObjectPath;

use crate::input::wayland::pointer_send::run_pointer;
use crate::input::wayland::remote_desktop::RemoteDesktop;

const SERVICE: &str = "org.gnome.Mutter.RemoteDesktop";
const ROOT_PATH: &str = "/org/gnome/Mutter/RemoteDesktop";
const SESSION_PATH: &str = "/org/gnome/Mutter/RemoteDesktop/Session/1";

#[derive(Clone)]
struct CallLog(Arc<Mutex<Vec<String>>>);

impl CallLog {
    fn record(&self, call: impl Into<String>) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(call.into());
    }

    fn calls(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

struct Manager(CallLog);

#[zbus::interface(name = "org.gnome.Mutter.RemoteDesktop")]
impl Manager {
    #[zbus(property)]
    fn version(&self) -> i32 {
        1
    }

    fn create_session(&self) -> zbus::fdo::Result<OwnedObjectPath> {
        self.0.record("create");
        OwnedObjectPath::try_from(SESSION_PATH)
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))
    }
}

struct Session(CallLog);

#[zbus::interface(name = "org.gnome.Mutter.RemoteDesktop.Session")]
impl Session {
    #[zbus(property)]
    fn session_id(&self) -> &str {
        "private-pointer-session"
    }

    fn start(&self) {
        self.0.record("start");
    }

    fn notify_pointer_motion_absolute(&self, _stream: &str, x: f64, y: f64) {
        self.0.record(format!("motion:{x}:{y}"));
    }

    fn notify_pointer_button(&self, button: i32, down: bool) {
        self.0.record(format!("button:{button}:{down}"));
    }

    fn stop(&self) -> zbus::fdo::Result<()> {
        self.0.record("stop:denied");
        Err(zbus::fdo::Error::AccessDenied(
            "the private compositor refuses Stop".to_owned(),
        ))
    }
}

struct ScreenCast;

#[zbus::interface(name = "org.gnome.Mutter.ScreenCast")]
impl ScreenCast {
    fn create_session(
        &self,
        _options: std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
    ) -> OwnedObjectPath {
        OwnedObjectPath::try_from(SESSION_PATH).unwrap()
    }
}

struct CastSession;

#[zbus::interface(name = "org.gnome.Mutter.ScreenCast.Session")]
impl CastSession {
    fn record_monitor(
        &self,
        connector: &str,
        _options: std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        if connector == "refused" {
            return Err(zbus::fdo::Error::AccessDenied("stream refused".into()));
        }
        Ok(OwnedObjectPath::try_from("/private/stream").unwrap())
    }
}

fn private_service(log: CallLog) -> zbus::Connection {
    zbus::block_on(async {
        Builder::session()
            .expect("the private session bus is available")
            .name(SERVICE)
            .expect("the fixture owns the RemoteDesktop name")
            .name("org.gnome.Mutter.ScreenCast")
            .unwrap()
            .serve_at(ROOT_PATH, Manager(log.clone()))
            .expect("the manager interface is served")
            .serve_at(SESSION_PATH, Session(log))
            .expect("the session interface is served")
            .serve_at("/org/gnome/Mutter/ScreenCast", ScreenCast)
            .unwrap()
            .serve_at(SESSION_PATH, CastSession)
            .unwrap()
            .build()
            .await
            .expect("the private compositor service starts")
    })
}

fn deadline() -> Deadline {
    Deadline::after(30_000).expect("a deadline builds")
}

#[test]
#[ignore = "requires scripts/private-session.sh without a compositor service"]
fn a_missing_mutter_capability_refuses_before_session_creation() {
    assert!(std::env::var_os("AGENT_DESKTOP_PRIVATE_SESSION").is_some());
    let check = || {
        let error = RemoteDesktop::open(deadline())
            .err()
            .expect("unsupported backend");
        assert_eq!(error.code, ErrorCode::PlatformNotSupported, "{error:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    };
    check();
    let owner = zbus::block_on(async {
        Builder::session()
            .unwrap()
            .name(SERVICE)
            .unwrap()
            .serve_at(ROOT_PATH, ScreenCast)
            .unwrap()
            .build()
            .await
            .unwrap()
    });
    check();
    drop(owner);
    let log = CallLog(Arc::new(Mutex::new(Vec::new())));
    let _service = private_service(log.clone());
    assert!(RemoteDesktop::open(deadline()).is_ok());
    assert!(
        log.calls().is_empty(),
        "capability detection must not create a session or send input"
    );
}

fn assert_stream_error_is_preserved(pointer: &mut RemoteDesktop, log: &CallLog) {
    let error = run_pointer(
        pointer,
        &agent_desktop_core::MouseEvent {
            point: Point { x: 640.0, y: 16.0 },
            button: MouseButton::Left,
            kind: agent_desktop_core::MouseEventKind::Click { count: 1 },
            modifiers: Vec::new(),
        },
        &[agent_desktop_core::DisplayInfo {
            id: "refused".into(),
            bounds: agent_desktop_core::Rect {
                x: 0.,
                y: 0.,
                width: 1280.,
                height: 800.,
            },
            is_primary: true,
            scale: 1.,
        }],
        &mut || Ok(()),
        deadline(),
    )
    .expect_err("the stream service refuses access");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(error.platform_detail.unwrap().contains("AccessDenied"));
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(error.details.unwrap()["physical_delivery_started"], false);
    assert_eq!(log.calls(), ["create", "stop:denied"]);
}

#[test]
#[ignore = "requires scripts/private-session.sh; starts only a private RemoteDesktop D-Bus fixture"]
fn a_completed_wayland_click_with_refused_stop_is_delivered_once_and_unsafe_to_retry() {
    let runtime = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION")
        .expect("run this test in scripts/private-session.sh");
    assert!(
        runtime.contains("/rt."),
        "the private runtime dir owns the test bus"
    );

    let log = CallLog(Arc::new(Mutex::new(Vec::new())));
    let _service = private_service(log.clone());
    let mut pointer = RemoteDesktop::open(deadline()).expect("the private session bus opens");
    assert_stream_error_is_preserved(&mut pointer, &log);
    let error = run_pointer(
        &mut pointer,
        &agent_desktop_core::MouseEvent {
            point: Point { x: 640.0, y: 16.0 },
            button: MouseButton::Left,
            kind: agent_desktop_core::MouseEventKind::Click { count: 1 },
            modifiers: Vec::new(),
        },
        &[agent_desktop_core::DisplayInfo {
            id: "private".into(),
            bounds: agent_desktop_core::Rect {
                x: 0.,
                y: 0.,
                width: 1280.,
                height: 800.,
            },
            is_primary: true,
            scale: 1.,
        }],
        &mut || Ok(()),
        deadline(),
    )
    .expect_err("Stop is refused after both click edges reached the service");

    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(
        error.details.expect("delivery evidence")["physical_delivery_started"],
        true
    );
    let calls = log.calls();
    let button_edges: Vec<&str> = calls
        .iter()
        .filter(|call| call.starts_with("button:"))
        .map(String::as_str)
        .collect();
    assert_eq!(button_edges, ["button:272:true", "button:272:false"]);
    assert_eq!(calls.last().map(String::as_str), Some("stop:denied"));
}
