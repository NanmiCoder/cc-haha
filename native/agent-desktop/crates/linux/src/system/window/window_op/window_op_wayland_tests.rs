use super::*;

fn cause(error: &AdapterError) -> String {
    error.details.as_ref().expect("details")["cause"]
        .as_str()
        .expect("a cause")
        .to_owned()
}

#[test]
fn a_native_wayland_window_has_no_client_and_is_refused_as_a_wayland_session_before_any_write() {
    let mut world = World::showing(state(0, 0, 1, 1));
    world.wayland = true;
    world
        .clients
        .replace([ControlRead::Ready(vec![client(CLIENT, "Another title")])].into());
    let error = run(&world, &window(), &WindowOp::Minimize, budget()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(cause(&error), "wayland_session");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    assert_eq!(world.writes(), 0);
}

#[test]
fn every_window_operation_on_a_wayland_session_reports_the_wayland_cause_with_no_manager() {
    for op in [
        WindowOp::Move { x: 10.0, y: 10.0 },
        WindowOp::Resize {
            width: 300.0,
            height: 200.0,
        },
        WindowOp::Minimize,
        WindowOp::Maximize,
        WindowOp::Restore,
    ] {
        let mut world = World::showing(state(10, 10, 400, 300));
        world.wayland = true;
        world.clients.replace([ControlRead::NoManager].into());
        let error = run(&world, &window(), &op, budget()).expect_err("refused");
        assert_eq!(error.code, ErrorCode::ActionNotSupported, "{op:?}");
        assert_eq!(cause(&error), "wayland_session", "{op:?}");
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
        assert_eq!(world.writes(), 0, "{op:?}");
    }
}

#[test]
fn restoring_a_minimized_xwayland_window_is_refused_as_a_wayland_session_without_a_request() {
    let mut hidden = state(0, 0, 400, 300);
    hidden.hidden = true;
    let mut world = World::showing(hidden);
    world.wayland = true;
    let error = run(&world, &window(), &WindowOp::Restore, budget()).expect_err("refused");
    assert_eq!(cause(&error), "wayland_session");
    assert_eq!(world.lifts.get(), 0);
    assert_eq!(world.writes(), 0);
}

#[test]
fn restoring_a_maximized_xwayland_window_still_unmaximizes() {
    let mut full = state(0, 69, 1280, 731);
    full.maximized_vertical = true;
    full.maximized_horizontal = true;
    let mut world = World::showing(full).then_showing(state(10, 10, 500, 380));
    world.wayland = true;
    run(&world, &window(), &WindowOp::Restore, budget()).expect("a restore");
    assert_eq!(world.writes.borrow()[0].1, WindowWrite::SetMaximized(false));
}
