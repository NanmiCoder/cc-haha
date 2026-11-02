use super::*;

fn refusal(world: &World, op: &WindowOp) -> AdapterError {
    let error = run(world, &window(), op, budget()).expect_err("a refusal");
    assert_eq!(world.writes(), 0, "a refusal sends nothing");
    error
}

fn cause(error: &AdapterError) -> String {
    error.details.as_ref().expect("details")["cause"]
        .as_str()
        .expect("a cause")
        .to_owned()
}

#[test]
fn a_wayland_session_is_not_supported_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.clients.replace([ControlRead::NotX11].into());
    let error = refusal(&world, &WindowOp::Minimize);
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(cause(&error), "wayland_session");
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn no_window_manager_is_not_supported_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.clients.replace([ControlRead::NoManager].into());
    let error = refusal(&world, &WindowOp::Maximize);
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(cause(&error), "no_window_manager");
}

#[test]
fn an_unreadable_display_is_not_delivered_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.clients.replace([ControlRead::Unavailable].into());
    let error = refusal(&world, &WindowOp::Restore);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn a_window_with_no_x11_client_is_not_supported_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world
        .clients
        .replace([ControlRead::Ready(vec![client(CLIENT, "Another title")])].into());
    let error = refusal(&world, &WindowOp::Minimize);
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(cause(&error), "window_not_mapped");
}

#[test]
fn an_ambiguous_mapping_is_an_ambiguous_target_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.clients.replace(
        [ControlRead::Ready(vec![
            client(CLIENT, "Doc"),
            client(CLIENT + 1, "Doc"),
        ])]
        .into(),
    );
    let error = refusal(&world, &WindowOp::Minimize);
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn sizes_that_are_not_sizes_are_invalid_args_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    for (width, height) in [
        (f64::NAN, 10.0),
        (10.0, f64::INFINITY),
        (0.0, 10.0),
        (0.4, 10.0),
        (10.0, 0.49),
        (10.0, -5.0),
        (1_000_001.0, 10.0),
    ] {
        let error = refusal(&world, &resize(width, height));
        assert_eq!(error.code, ErrorCode::InvalidArgs);
        assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    }
}

#[test]
fn coordinates_that_are_not_places_are_invalid_args_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    for (x, y) in [
        (f64::NAN, 0.0),
        (0.0, f64::NEG_INFINITY),
        (1_000_001.0, 0.0),
        (0.0, -1_000_001.0),
    ] {
        let error = refusal(&world, &WindowOp::Move { x, y });
        assert_eq!(error.code, ErrorCode::InvalidArgs);
    }
}

#[test]
fn a_window_listed_without_its_process_instance_is_stale_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    let mut win = window();
    win.process_instance = None;
    let error = run(&world, &win, &WindowOp::Minimize, budget()).expect_err("stale");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(world.writes(), 0);
}

#[test]
fn a_different_instance_of_the_pid_is_stale_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.lookups.replace([process("other:1")].into());
    let error = refusal(&world, &WindowOp::Minimize);
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn an_exited_process_is_stale_before_any_write() {
    let world = World::showing(state(0, 0, 1, 1));
    world.lookups.replace([Lookup::Gone].into());
    let error = refusal(&world, &WindowOp::Minimize);
    assert_eq!(error.code, ErrorCode::StaleRef);
}

#[test]
fn restore_of_a_visible_window_that_is_not_maximized_is_ok_without_a_write() {
    let world = World::showing(state(0, 0, 400, 300));
    run(&world, &window(), &WindowOp::Restore, budget()).expect("nothing to restore");
    assert_eq!(world.writes(), 0);
    assert_eq!(world.lifts.get(), 0);
}

#[test]
fn restore_of_a_hidden_window_that_stays_hidden_names_the_manager_and_is_not_success() {
    let mut hidden = state(0, 0, 400, 300);
    hidden.hidden = true;
    let mut world = World::showing(hidden);
    world.lift_result = Lifted::StillHidden {
        manager: "Mutter".to_owned(),
    };
    let error = run(&world, &window(), &WindowOp::Restore, budget()).expect_err("refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert!(error.message.contains("Mutter"));
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.writes(), 0);
}

fn refused_restore(overview: Option<bool>) -> (AdapterError, World) {
    let mut hidden = state(0, 0, 400, 300);
    hidden.hidden = true;
    let mut world = World::showing(hidden);
    world.lift_result = Lifted::StillHidden {
        manager: "GNOME Shell".to_owned(),
    };
    world.overview = overview;
    let error = run(&world, &window(), &WindowOp::Restore, budget()).expect_err("refused");
    (error, world)
}

#[test]
fn restore_refused_while_the_overview_is_open_names_the_overview_as_the_cause() {
    let (error, world) = refused_restore(Some(true));
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(cause(&error), "overview_open");
    assert!(error.message.contains("Activities Overview"));
    assert!(error.message.contains("GNOME Shell"));
    assert_eq!(
        error.suggestion.as_deref(),
        Some("Close the Activities Overview (press Escape), then retry")
    );
    assert_eq!(error.details.expect("details")["manager"], "GNOME Shell");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.overview_reads.get(), 1);
    assert_eq!(world.writes(), 0);
}

#[test]
fn restore_refused_with_the_overview_closed_or_unreadable_keeps_restore_refused() {
    for overview in [Some(false), None] {
        let (error, world) = refused_restore(overview);
        assert_eq!(error.code, ErrorCode::ActionNotSupported, "{overview:?}");
        assert_eq!(cause(&error), "restore_refused", "{overview:?}");
        assert!(error.message.contains("GNOME Shell"));
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        assert_eq!(world.overview_reads.get(), 1, "{overview:?}");
    }
}

#[test]
fn restore_that_shows_the_window_never_reads_the_overview() {
    let mut hidden = state(0, 0, 400, 300);
    hidden.hidden = true;
    let mut world = World::showing(hidden).then_showing(state(0, 0, 400, 300));
    world.overview = Some(true);
    run(&world, &window(), &WindowOp::Restore, budget()).expect("the window is shown");
    assert_eq!(world.lifts.get(), 1);
    assert_eq!(world.overview_reads.get(), 0);
}

#[test]
fn restore_of_a_visible_window_never_reads_the_overview() {
    let mut world = World::showing(state(0, 0, 400, 300));
    world.overview = Some(true);
    run(&world, &window(), &WindowOp::Restore, budget()).expect("nothing to restore");
    assert_eq!(world.overview_reads.get(), 0);
}
