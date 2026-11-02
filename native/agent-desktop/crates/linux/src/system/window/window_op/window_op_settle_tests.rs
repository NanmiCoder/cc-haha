use super::*;

#[test]
fn a_resize_with_continuous_rectangle_drift_is_not_verified() {
    fn drifting(_: &[WindowWrite]) -> WindowFacts {
        thread_local! {
            static POSITION: Cell<bool> = const { Cell::new(false) };
        }
        let x = POSITION.with(|position| i32::from(position.replace(!position.get())) * 20);
        state(x, 0, 520, 380)
    }
    let mut world = World::showing(state(0, 0, 400, 300));
    world.reaction = Some(drifting);
    let (verdict, _) = super::super::settle(
        &world,
        CLIENT,
        &requested(&resize(520.0, 380.0)).unwrap().unwrap(),
        Deadline::after(500).unwrap(),
    );
    assert_eq!(verdict, Verdict::Mismatch);
}

#[test]
fn unreadable_ownership_after_a_write_is_unverified_not_missing() {
    let mut unreadable_client = client(CLIENT, "Doc");
    unreadable_client.pid = None;
    for (lookup, clients) in [
        (
            Lookup::Unreadable,
            ControlRead::Ready(vec![client(CLIENT, "Doc")]),
        ),
        (process(INSTANCE), ControlRead::Unavailable),
        (
            process(INSTANCE),
            ControlRead::Ready(vec![unreadable_client]),
        ),
    ] {
        let mut maximized = state(0, 0, 400, 300);
        maximized.maximized_vertical = true;
        maximized.maximized_horizontal = true;
        let world = World::showing(maximized);
        world.lookups.replace([process(INSTANCE), lookup].into());
        world
            .clients
            .replace([ControlRead::Ready(vec![client(CLIENT, "Doc")]), clients].into());
        let error = run(&world, &window(), &WindowOp::Maximize, budget())
            .expect_err("ownership cannot be verified");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        assert_eq!(
            error.details.expect("cause")["cause"],
            "ownership_unverified"
        );
        assert_eq!(world.writes(), 1);
    }
}

#[test]
fn a_move_seen_only_in_passing_is_not_the_held_result() {
    let world = World::showing(state(10, 10, 400, 300))
        .then_showing(state(300, 200, 400, 300))
        .then_showing(state(60, 90, 400, 300));
    let error = run(
        &world,
        &window(),
        &WindowOp::Move { x: 300.0, y: 200.0 },
        budget(),
    )
    .expect_err("the slide kept going past the asked place");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["observed"]["x"], 60);
    assert_eq!(details["observed"]["y"], 90);
}

#[test]
fn a_move_without_time_for_the_confirmation_pause_is_unverified() {
    let world = World::showing(state(300, 200, 400, 300));
    let error = run(
        &world,
        &window(),
        &WindowOp::Move { x: 300.0, y: 200.0 },
        Deadline::after(100).expect("a deadline builds"),
    )
    .expect_err("two immediate reads cannot prove the place held");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.writes(), 1);
}

fn confirmation_returning_after_the_limit(
    written: &[WindowWrite],
    late: WindowFacts,
) -> WindowFacts {
    thread_local! {
        static READS: Cell<u32> = const { Cell::new(0) };
    }
    if written.is_empty() {
        return state(10, 10, 400, 300);
    }
    let first = READS.with(|reads| reads.replace(reads.get() + 1) == 0);
    if first {
        state(300, 200, 400, 300)
    } else {
        std::thread::sleep(SETTLE_BUDGET);
        late
    }
}

fn late_and_moved_again(written: &[WindowWrite]) -> WindowFacts {
    confirmation_returning_after_the_limit(written, state(60, 90, 400, 300))
}

fn late_and_unchanged(written: &[WindowWrite]) -> WindowFacts {
    confirmation_returning_after_the_limit(written, state(300, 200, 400, 300))
}

fn move_confirmed_late(reaction: fn(&[WindowWrite]) -> WindowFacts) -> AdapterError {
    let mut world = World::showing(state(10, 10, 400, 300));
    world.reaction = Some(reaction);
    run(
        &world,
        &window(),
        &WindowOp::Move { x: 300.0, y: 200.0 },
        Deadline::after(2_000).expect("a deadline builds"),
    )
    .expect_err("a confirmation read past the limit cannot prove the place held")
}

#[test]
fn a_confirmation_that_returns_after_the_limit_reports_its_latest_rectangle() {
    let error = move_confirmed_late(late_and_moved_again);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["observed"]["x"], 60);
    assert_eq!(details["observed"]["y"], 90);
}

#[test]
fn a_confirmation_that_agrees_but_returns_after_the_limit_is_not_a_held_place() {
    let error = move_confirmed_late(late_and_unchanged);
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
}

#[test]
fn a_replacement_client_cannot_confirm_the_original_windows_operation() {
    let mut maximized = state(0, 0, 400, 300);
    maximized.maximized_vertical = true;
    maximized.maximized_horizontal = true;
    let world = World::showing(maximized);
    let mut replacement = client(CLIENT, "Doc");
    replacement.pid = Some(999);
    world.clients.replace(
        [
            ControlRead::Ready(vec![client(CLIENT, "Doc")]),
            ControlRead::Ready(vec![replacement]),
        ]
        .into(),
    );
    let error = run(&world, &window(), &WindowOp::Maximize, budget())
        .expect_err("a replacement's matching state is not delivery proof");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let current = World::showing(maximized);
    run(&current, &window(), &WindowOp::Maximize, budget()).expect("the current owner confirms");
}
