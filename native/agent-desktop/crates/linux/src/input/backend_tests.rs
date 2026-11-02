use std::path::Path;

use agent_desktop_core::ErrorCode;

use super::{Backend, select};
use crate::system::display::display_cause::Cause;
use crate::system::display::display_env::DisplayEnv;
use crate::system::display::display_reach::Reach;
use crate::system::display::display_server::{DisplayServer, Probe, detect};
use crate::system::display::display_unavailable::Unavailable;

struct Fixed {
    wayland: Reach,
    x11: Reach,
}

impl Probe for Fixed {
    fn wayland(&self, _socket: &Path) -> Reach {
        self.wayland
    }

    fn x11(&self, _display: &str) -> Reach {
        self.x11
    }
}

fn env(wayland: Option<&str>, display: Option<&str>) -> DisplayEnv {
    DisplayEnv {
        wayland: wayland.map(str::to_owned),
        display: display.map(str::to_owned),
        runtime_dir: Some("/run/user/1000".into()),
    }
}

#[test]
fn an_x11_answer_selects_the_x11_backend_with_the_display() {
    let backend = select(DisplayServer::X11(":7".into())).expect("backend");

    assert_eq!(backend, Backend::X11(":7".into()));
}

#[test]
fn a_wayland_answer_selects_the_wayland_backend() {
    assert_eq!(
        select(DisplayServer::Wayland).expect("backend"),
        Backend::Wayland
    );
}

#[test]
fn no_display_is_a_platform_error_that_names_both_variables() {
    let unavailable = Unavailable {
        cause: Cause::NotConfigured,
        detail: String::new(),
    };

    let error = select(DisplayServer::Unavailable(unavailable)).expect_err("no display");

    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(
        error
            .suggestion
            .as_deref()
            .expect("suggestion")
            .contains("WAYLAND_DISPLAY")
    );
    assert_eq!(
        error.details.expect("details")["physical_delivery_started"],
        false
    );
}

#[test]
fn every_unreachable_input_cause_uses_the_shared_display_error() {
    for cause in [Cause::NotConfigured, Cause::Missing, Cause::Refused] {
        let unavailable = Unavailable {
            cause,
            detail: "test endpoint".into(),
        };
        let expected =
            crate::system::display::route::resolve(DisplayServer::Unavailable(unavailable.clone()))
                .expect_err("unreachable");
        let actual = select(DisplayServer::Unavailable(unavailable)).expect_err("unreachable");
        assert_eq!(actual.code, expected.code);
        assert_eq!(actual.message, expected.message);
        assert_eq!(
            actual.details.as_ref().expect("details")["display_unavailable"],
            expected.details.expect("details")["display_unavailable"]
        );
        assert_eq!(
            actual.disposition,
            agent_desktop_core::DeliverySemantics::not_delivered()
        );
    }
}

#[test]
fn a_stale_wayland_socket_with_a_working_display_selects_x11() {
    let probe = Fixed {
        wayland: Reach::Missing,
        x11: Reach::Connected,
    };
    let server = detect(&env(Some("wayland-9"), Some(":1")), &probe);

    assert_eq!(select(server).expect("backend"), Backend::X11(":1".into()));
}

#[test]
fn a_live_wayland_socket_decides_before_a_set_display() {
    let probe = Fixed {
        wayland: Reach::Connected,
        x11: Reach::Connected,
    };
    let server = detect(&env(Some("wayland-0"), Some(":1")), &probe);

    assert_eq!(select(server).expect("backend"), Backend::Wayland);
}

#[test]
fn the_backend_choice_never_reads_the_environment_itself() {
    let source = include_str!("backend.rs");

    for forbidden in ["std::env", "env::var", "XDG_SESSION_TYPE"] {
        assert!(
            !source.contains(forbidden),
            "backend selection must consume the session detector, found {forbidden}"
        );
    }
}
