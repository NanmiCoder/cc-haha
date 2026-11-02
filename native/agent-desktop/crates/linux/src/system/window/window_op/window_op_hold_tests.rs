use super::*;

fn shifted_by_the_frame(written: &[WindowWrite]) -> WindowFacts {
    let moved_back = written.iter().any(|write| {
        matches!(
            write,
            WindowWrite::MoveResize {
                x: Some(300),
                y: Some(200),
                ..
            }
        )
    });
    if moved_back {
        state(300, 200, 520, 380)
    } else if written.is_empty() {
        state(300, 200, 400, 300)
    } else {
        state(301, 222, 520, 380)
    }
}

#[test]
fn a_resize_that_shifts_the_client_gives_the_place_back() {
    let mut world = World::showing(state(300, 200, 400, 300));
    world.reaction = Some(shifted_by_the_frame);
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    run(&world, &window(), &resize(520.0, 380.0), deadline).expect("a resize that holds place");
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[1].1,
        WindowWrite::MoveResize {
            x: Some(300),
            y: Some(200),
            width: None,
            height: None
        }
    );
}

#[test]
fn a_size_that_fits_only_for_a_moment_is_not_a_success() {
    let world = World::showing(state(0, 0, 400, 300))
        .then_showing(state(0, 0, 5000, 5000))
        .then_showing(state(0, 0, 1280, 800));
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    let error = run(&world, &window(), &resize(5000.0, 5000.0), deadline)
        .expect_err("the toolkit clamped the size");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.expect("details");
    assert_eq!(details["observed"]["width"], 1280);
    assert_eq!(details["observed"]["height"], 800);
}

#[test]
fn a_clamped_resize_that_also_shifted_the_client_still_gives_the_place_back() {
    fn clamped_and_shifted(written: &[WindowWrite]) -> WindowFacts {
        let back = written.iter().any(|write| {
            matches!(
                write,
                WindowWrite::MoveResize {
                    x: Some(300),
                    y: Some(200),
                    ..
                }
            )
        });
        match (written.is_empty(), back) {
            (true, _) => state(300, 200, 400, 300),
            (false, true) => state(300, 200, 900, 500),
            (false, false) => state(301, 222, 900, 500),
        }
    }
    let mut world = World::showing(state(300, 200, 400, 300));
    world.reaction = Some(clamped_and_shifted);
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    let error = run(&world, &window(), &resize(5000.0, 5000.0), deadline).expect_err("clamped");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    assert_eq!(world.writes(), 2);
    let details = error.details.expect("details");
    assert_eq!(details["observed"]["x"], 300);
    assert_eq!(details["observed"]["y"], 200);
    assert_eq!(details["observed"]["width"], 900);
    assert_eq!(details["observed"]["height"], 500);
}

#[test]
fn a_place_the_resize_slide_only_passed_through_is_still_held() {
    let world = World::showing(state(300, 200, 400, 300))
        .then_showing(state(60, 90, 520, 380))
        .then_showing(state(60, 90, 520, 380))
        .then_showing(state(300, 200, 520, 380))
        .then_showing(state(60, 90, 520, 380))
        .then_showing(state(60, 90, 520, 380))
        .then_showing(state(300, 200, 520, 380));
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    run(&world, &window(), &resize(520.0, 380.0), deadline).expect("the hold lands");
    assert_eq!(world.writes(), 2);
}

fn oversize_and_shifted(written: &[WindowWrite]) -> WindowFacts {
    if written.is_empty() {
        state(300, 200, 400, 300)
    } else {
        state(-1200, 0, 5000, 5000)
    }
}

#[test]
fn a_resize_beyond_every_display_is_not_judged_by_the_place_the_manager_gave_it() {
    let mut world = World::showing(state(300, 200, 400, 300));
    world.reaction = Some(oversize_and_shifted);
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    run(&world, &window(), &resize(5000.0, 5000.0), deadline).expect("the size was taken");
    assert_eq!(world.writes(), 1);
}

fn kept_on_the_display(written: &[WindowWrite]) -> WindowFacts {
    if written.is_empty() {
        state(400, 450, 494, 291)
    } else {
        state(400, 201, 804, 599)
    }
}

#[test]
fn a_resize_the_manager_moved_to_keep_it_on_the_display_is_judged_by_its_size() {
    let mut world = World::showing(state(400, 450, 494, 291));
    world.reaction = Some(kept_on_the_display);
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    let report = run(&world, &window(), &resize(804.0, 599.0), deadline).expect("the size held");
    assert_eq!(world.writes(), 1);
    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    let details = report.result.details.expect("details");
    assert_eq!(details["verification_scope"], "window_size");
    assert_eq!(details["observed"]["x"], 400);
    assert_eq!(details["observed"]["y"], 201);
    assert_eq!(details["observed"]["width"], 804);
    assert_eq!(details["observed"]["height"], 599);
}

fn shifted_and_not_given_back(written: &[WindowWrite]) -> WindowFacts {
    if written.is_empty() {
        state(300, 200, 400, 300)
    } else {
        state(301, 222, 520, 380)
    }
}

#[test]
fn a_resize_whose_origin_the_manager_will_not_give_back_still_holds_its_size() {
    let mut world = World::showing(state(300, 200, 400, 300));
    world.reaction = Some(shifted_and_not_given_back);
    let deadline = Deadline::after(2_000).expect("a deadline builds");
    let report = run(&world, &window(), &resize(520.0, 380.0), deadline).expect("the size held");
    assert_eq!(
        report.disposition(),
        DeliverySemantics::delivered_verified()
    );
    let details = report.result.details.expect("details");
    assert_eq!(details["observed"]["x"], 301);
    assert_eq!(details["observed"]["y"], 222);
}

fn clamps_the_vertical_axis_of_a_restored_place(written: &[WindowWrite]) -> WindowFacts {
    let at = |x: i32| WindowWrite::MoveResize {
        x: Some(x),
        y: Some(200),
        width: None,
        height: None,
    };
    match written.last() {
        None => state(0, 21, 520, 380),
        Some(last) if *last == at(340) => state(340, 190, 520, 380),
        Some(last) if *last == at(300) => state(300, 190, 520, 380),
        Some(_) => state(0, 190, 520, 380),
    }
}

#[test]
fn a_manager_that_clamps_one_axis_of_the_place_still_gets_the_other_given_back() {
    let mut world = World::showing(state(0, 21, 520, 380));
    world.reaction = Some(clamps_the_vertical_axis_of_a_restored_place);
    *world.remembered.borrow_mut() = Some(Extents {
        x: 300,
        y: 200,
        width: 520,
        height: 380,
    });
    let deadline = Deadline::after(3_000).expect("a deadline builds");
    let error = run(&world, &window(), &WindowOp::Restore, deadline).expect_err("y is clamped");
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let writes = world.writes.borrow();
    assert_eq!(writes.len(), 3);
    assert_eq!(
        writes[2].1,
        WindowWrite::MoveResize {
            x: Some(300),
            y: Some(200),
            width: None,
            height: None
        }
    );
}
