use super::*;

fn client_rectangle(written: &[WindowWrite]) -> WindowFacts {
    let mut at = (206, 72, 866, 629);
    for write in written {
        if let WindowWrite::MoveResize {
            x,
            y,
            width,
            height,
        } = write
        {
            at = (
                x.unwrap_or(at.0),
                y.unwrap_or(at.1),
                width.map_or(at.2, |side| side as i32),
                height.map_or(at.3, |side| side as i32),
            );
        }
    }
    state(at.0, at.1, at.2, at.3)
}

fn shadowed() -> World {
    let mut world = World::showing(state(206, 72, 866, 629));
    let mut shadowed = client(CLIENT, "Doc");
    shadowed.shadow = (26, 23, 26, 29);
    world
        .clients
        .replace([ControlRead::Ready(vec![shadowed])].into());
    world.reaction = Some(client_rectangle);
    world
}

#[test]
fn a_move_of_a_shadowed_window_reads_back_where_it_was_asked() {
    let world = shadowed();
    run(
        &world,
        &window(),
        &WindowOp::Move { x: 300.0, y: 200.0 },
        budget(),
    )
    .expect("the move holds");
    let writes = world.writes.borrow();
    assert_eq!(
        writes[0].1,
        WindowWrite::MoveResize {
            x: Some(274),
            y: Some(177),
            width: None,
            height: None,
        }
    );
}

#[test]
fn a_resize_of_a_shadowed_window_reads_back_the_size_it_was_asked() {
    let world = shadowed();
    let report = run(&world, &window(), &resize(814.0, 577.0), budget()).expect("the resize holds");
    let details = report.result.details.expect("details");
    assert_eq!(details["observed"]["x"], 232);
    assert_eq!(details["observed"]["width"], 814);
    assert_eq!(
        world.writes.borrow()[0].1,
        WindowWrite::MoveResize {
            x: None,
            y: None,
            width: Some(866),
            height: Some(629),
        }
    );
}

#[test]
fn a_resize_the_manager_clamped_reports_the_visible_size_it_held() {
    let mut world = shadowed();
    world.reaction = None;
    world.facts = RefCell::new(VecDeque::from([ControlRead::Ready(state(
        206, 72, 696, 431,
    ))]));
    let error = run(&world, &window(), &resize(700.0, 450.0), budget()).expect_err("a clamp");
    let details = error.details.expect("details");
    assert_eq!(details["requested"]["width"], 700);
    assert_eq!(details["requested"]["height"], 450);
    assert_eq!(details["observed"]["x"], 232);
    assert_eq!(details["observed"]["y"], 95);
    assert_eq!(details["observed"]["width"], 644);
    assert_eq!(details["observed"]["height"], 379);
}
