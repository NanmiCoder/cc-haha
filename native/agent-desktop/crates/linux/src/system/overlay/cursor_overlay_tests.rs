use agent_desktop_core::{CursorOverlayConfig, CursorOverlayInstruction, Point, SystemOps};
use x11rb::connection::Connection;
use x11rb::protocol::shape::{ConnectionExt as _, SK};
use x11rb::protocol::xproto::*;

use super::*;
use crate::system::x11::capture::xwd_oracle::xwd_pixel;

fn update(control: &CursorOverlayControl) -> Result<(), AdapterError> {
    crate::LinuxAdapter::new().update_cursor_overlay(control)
}

#[test]
fn a_wayland_cursor_refusal_is_explicit_without_x11_fallback() {
    const CHILD: &str = "AD_CURSOR_WAYLAND_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let error = update(&CursorOverlayControl::enable(
            "wayland-proof".into(),
            Default::default(),
        ))
        .expect_err("unsupported");
        assert_eq!(
            error.code,
            agent_desktop_core::ErrorCode::PlatformNotSupported
        );
        let details = error.details.expect("explicit overlay state");
        assert_eq!(details["rendered"], false);
        assert_eq!(details["cause"], "wayland_session");
        return;
    }
    let path = std::env::current_dir()
        .unwrap()
        .join(format!(".cursor-wayland-{}.sock", std::process::id()));
    let listener = std::os::unix::net::UnixListener::bind(&path).expect("reachable Wayland socket");
    const FILTER: &str = "system::overlay::cursor_overlay::tests::a_wayland_cursor_refusal_is_explicit_without_x11_fallback";
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", FILTER, "--nocapture"])
        .env(CHILD, "1")
        .env("WAYLAND_DISPLAY", &path)
        .output()
        .unwrap();
    drop(listener);
    std::fs::remove_file(path).unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
        "{FILTER} must execute exactly one test: {output:?}"
    );
}

#[test]
#[ignore = "needs a private X11 desktop; run through scripts/private-session.sh"]
fn live_x11_cursor_adapter_paints_agent_positions_and_retires_resources() {
    let dir = std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private desktop");
    let (oracle, index) = x11rb::connect(None).expect("independent X11 connection");
    let root = oracle.setup().roots[index].root;
    let owner = oracle
        .intern_atom(false, b"_AGENT_DESKTOP_CURSOR_OWNER")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let owned = |session: &str| {
        oracle
            .query_tree(root)
            .unwrap()
            .reply()
            .unwrap()
            .children
            .into_iter()
            .filter(|window| {
                oracle
                    .get_property(false, *window, owner, AtomEnum::STRING, 0, 1024)
                    .unwrap()
                    .reply()
                    .ok()
                    .and_then(|property| {
                        serde_json::from_slice::<(String, Option<String>)>(&property.value).ok()
                    })
                    .is_some_and(|(id, _)| id == session)
            })
            .collect::<Vec<_>>()
    };
    crate::LinuxAdapter::new()
        .list_displays(Deadline::after(4_000).unwrap())
        .unwrap();
    let pointer = oracle.query_pointer(root).unwrap().reply().unwrap();
    let mut white = agent_desktop_core::CursorOverlayStyle::default();
    white.set_fill("#FFFFFF".into());
    update(&CursorOverlayControl::enable(
        "pixel-proof".into(),
        white.clone(),
    ))
    .expect("enable retained overlay");
    let config = CursorOverlayConfig::enabled(None, 8).expect("enabled config");
    let mut window = None;
    for (x, y) in [(150., 150.), (500., 400.)] {
        update(&CursorOverlayControl::present_with_style(
            "pixel-proof".into(),
            CursorOverlayInstruction::new(Point { x, y }, &config, false).unwrap(),
            white.clone(),
        ))
        .expect("paint and acknowledge");
        let windows = owned("pixel-proof");
        assert_eq!(windows.len(), 1, "one retained window for this session");
        let id = windows[0];
        assert_eq!(*window.get_or_insert(id), id, "updates reuse one window");
        let attributes = oracle.get_window_attributes(id).unwrap().reply().unwrap();
        assert!(attributes.override_redirect);
        assert_eq!(attributes.map_state, MapState::VIEWABLE);
        let geometry = oracle.get_geometry(id).unwrap().reply().unwrap();
        assert_eq!(geometry.depth, 32);
        assert_eq!((geometry.x, geometry.y), (x as i16, y as i16));
        assert_eq!(xwd_pixel(id, 3, 10, &dir), [255, 255, 255]);
        let physical = oracle.query_pointer(root).unwrap().reply().unwrap();
        assert_eq!(
            (physical.root_x, physical.root_y),
            (pointer.root_x, pointer.root_y)
        );
        assert!(
            oracle
                .shape_get_rectangles(id, SK::INPUT)
                .unwrap()
                .reply()
                .unwrap()
                .rectangles
                .is_empty(),
            "cursor must not intercept input"
        );
    }
    update(&CursorOverlayControl::enable(
        "other-proof".into(),
        Default::default(),
    ))
    .expect("another retained client");
    let others = owned("other-proof");
    assert_eq!(others.len(), 1);
    let other = others[0];
    update(&CursorOverlayControl::disable("pixel-proof".into())).expect("synchronous teardown");
    assert!(
        !oracle
            .query_tree(root)
            .unwrap()
            .reply()
            .unwrap()
            .children
            .contains(&window.expect("painted window"))
    );
    assert!(
        oracle
            .query_tree(root)
            .unwrap()
            .reply()
            .unwrap()
            .children
            .contains(&other),
        "teardown must leave another session alone"
    );
    update(&CursorOverlayControl::disable("other-proof".into())).expect("other teardown");
    assert!(
        !oracle
            .query_tree(root)
            .unwrap()
            .reply()
            .unwrap()
            .children
            .contains(&other)
    );
}

#[test]
#[ignore = "needs scripts/private-session.sh --wm -- scripts/private-wayland-shell.sh --"]
fn live_wayland_cursor_refusal_reports_unrendered_without_an_x11_window() {
    std::env::var("AGENT_DESKTOP_PRIVATE_SESSION").expect("private desktop");
    assert!(!std::env::var("WAYLAND_DISPLAY").unwrap().is_empty());
    let (oracle, index) = x11rb::connect(None).expect("private fallback X11 display");
    let root = oracle.setup().roots[index].root;
    let owner = oracle
        .intern_atom(false, b"_AGENT_DESKTOP_CURSOR_OWNER")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let error = update(&CursorOverlayControl::enable(
        "wayland-live-proof".into(),
        Default::default(),
    ))
    .expect_err("Wayland overlay is unsupported");
    assert_eq!(
        error.code,
        agent_desktop_core::ErrorCode::PlatformNotSupported
    );
    let details = error.details.expect("explicit overlay outcome");
    assert_eq!(details["rendered"], false);
    assert_eq!(details["cause"], "wayland_session");
    for window in oracle.query_tree(root).unwrap().reply().unwrap().children {
        let property = oracle
            .get_property(false, window, owner, AtomEnum::STRING, 0, 1024)
            .unwrap()
            .reply();
        if let Ok(property) = property {
            let id = serde_json::from_slice::<(String, Option<String>)>(&property.value).ok();
            assert!(id.is_none_or(|(session, _)| session != "wayland-live-proof"));
        }
    }
}
