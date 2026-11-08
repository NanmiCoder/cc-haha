use super::*;

fn maximized() -> WindowFacts {
    let mut facts = state(0, 21, 1280, 779);
    facts.maximized_vertical = true;
    facts.maximized_horizontal = true;
    facts
}

#[test]
fn a_restore_gives_back_the_remembered_place_with_a_move_of_the_client() {
    let world = World::showing(maximized())
        .then_showing(state(121, 112, 500, 380))
        .then_showing(state(121, 112, 500, 380))
        .then_showing(state(120, 90, 500, 380));
    *world.remembered.borrow_mut() = Some(Extents {
        x: 120,
        y: 90,
        width: 500,
        height: 380,
    });
    run(&world, &window(), &WindowOp::Restore, budget()).expect("a restore");
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].1, WindowWrite::SetMaximized(false));
    assert_eq!(
        writes[1].1,
        WindowWrite::MoveResize {
            x: Some(120),
            y: Some(90),
            width: None,
            height: None
        }
    );
    assert_eq!(*world.remember_calls.borrow(), vec![None]);
}

#[test]
fn a_place_the_manager_did_not_give_back_is_unverified_and_stays_remembered() {
    let world = World::showing(maximized())
        .then_showing(state(121, 112, 500, 380))
        .then_showing(state(121, 112, 500, 380));
    *world.remembered.borrow_mut() = Some(Extents {
        x: 120,
        y: 90,
        width: 500,
        height: 380,
    });
    let error = run(&world, &window(), &WindowOp::Restore, budget()).expect_err("a miss");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert!(world.remember_calls.borrow().is_empty());
}

fn skips_a_move_to_the_place_it_believes_current(written: &[WindowWrite]) -> WindowFacts {
    let at = |x: i32| WindowWrite::MoveResize {
        x: Some(x),
        y: Some(90),
        width: None,
        height: None,
    };
    match written.last() {
        None => maximized(),
        Some(last) if *last == at(160) => state(160, 90, 500, 380),
        Some(last) if *last == at(120) && written.contains(&at(160)) => state(120, 90, 500, 380),
        Some(_) => state(121, 112, 500, 380),
    }
}

#[test]
fn a_manager_that_skips_a_move_to_the_place_it_believes_is_current_is_nudged_away_and_back() {
    let mut world = World::showing(maximized());
    world.reaction = Some(skips_a_move_to_the_place_it_believes_current);
    *world.remembered.borrow_mut() = Some(Extents {
        x: 120,
        y: 90,
        width: 500,
        height: 380,
    });
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    run(&world, &window(), &WindowOp::Restore, deadline).expect("a restore");
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 4);
    assert!(matches!(
        &writes[2].1,
        WindowWrite::MoveResize {
            x: Some(160),
            y: Some(90),
            ..
        }
    ));
}

#[test]
fn a_restore_without_time_to_confirm_keeps_the_remembered_place() {
    let facts = state(120, 90, 500, 380);
    let world = World::showing(facts);
    *world.remembered.borrow_mut() = Some(facts.client);
    let error = run(
        &world,
        &window(),
        &WindowOp::Restore,
        Deadline::after(100).expect("a deadline builds"),
    )
    .expect_err("the give-back needs a full confirmation pause");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(*world.remembered.borrow(), Some(facts.client));
    assert!(world.remember_calls.borrow().is_empty());
}

#[test]
fn a_place_the_unmaximize_slide_only_passed_through_is_still_written_to() {
    let world = World::showing(maximized())
        .then_showing(state(80, 40, 500, 380))
        .then_showing(state(120, 90, 500, 380))
        .then_showing(state(60, 90, 500, 380))
        .then_showing(state(120, 90, 500, 380));
    *world.remembered.borrow_mut() = Some(Extents {
        x: 120,
        y: 90,
        width: 500,
        height: 380,
    });
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    run(&world, &window(), &WindowOp::Restore, deadline).expect("the give-back lands");
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[1].1,
        WindowWrite::MoveResize {
            x: Some(120),
            y: Some(90),
            width: None,
            height: None
        }
    );
}

#[test]
fn a_retried_restore_of_an_unmaximized_window_still_gives_back_the_place_that_was_kept() {
    let world = World::showing(state(160, 90, 500, 380))
        .then_showing(state(160, 90, 500, 380))
        .then_showing(state(120, 90, 500, 380));
    *world.remembered.borrow_mut() = Some(Extents {
        x: 120,
        y: 90,
        width: 500,
        height: 380,
    });
    run(&world, &window(), &WindowOp::Restore, budget()).expect("the retry applies the place");
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].1,
        WindowWrite::MoveResize {
            x: Some(120),
            y: Some(90),
            width: None,
            height: None
        }
    );
    assert_eq!(*world.remember_calls.borrow(), vec![None]);
}
